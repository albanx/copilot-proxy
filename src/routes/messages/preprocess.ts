import {
  getReasoningEffortForModel,
  type ReasoningEffort,
} from "~/lib/config"
import { type Model } from "~/services/copilot/get-models"

import { type AnthropicMessagesPayload } from "./anthropic-types"

/**
 * Extract a `major.minor` version from a Copilot model id, e.g.
 * `claude-opus-4.8` -> `"4.8"`. Returns null when the id carries no dotted
 * version (older `claude-3-5-…` style ids), which callers treat as "not
 * version-gated".
 *
 * Local stand-in for the reference's `normalizeSdkModelId(...).version`: this
 * proxy has no `~/lib/models` SDK-id normalizer, so we read the version
 * straight off the model id.
 */
const extractModelVersion = (model: string): string | null => {
  const match = /(\d+\.\d+)/.exec(model)
  return match ? match[1] : null
}

/**
 * Compare a dotted version string against a `major.minor` floor. Mirrors the
 * reference `isVersionAtLeast`: parse both parts as base-10 integers, bail to
 * false on any non-integer part, then compare major-then-minor.
 */
const isVersionAtLeast = (
  version: string,
  minimumMajor: number,
  minimumMinor: number,
): boolean => {
  const [majorPart, minorPart = "0"] = version.split(".")
  const major = Number.parseInt(majorPart, 10)
  const minor = Number.parseInt(minorPart, 10)
  if (Number.isNaN(major) || Number.isNaN(minor)) return false
  return major > minimumMajor || (major === minimumMajor && minor >= minimumMinor)
}

/**
 * Newer Claude models (>= 4.7) stream summarized reasoning on the native
 * `/v1/messages` endpoint; force `thinking.display = "summarized"` for them.
 */
const shouldSummarizeThinkingDisplayForModel = (model: string): boolean => {
  const version = extractModelVersion(model)
  return version !== null && isVersionAtLeast(version, 4, 7)
}

/**
 * Placeholder emitted by some clients for an in-flight reasoning block before
 * the real (signed) thinking text arrives. Copilot's native `/v1/messages`
 * rejects it as an invalid signed block, so it must be filtered from history.
 */
const THINKING_PLACEHOLDER = "Thinking..."

/**
 * Copilot's native `/v1/messages` rejects a request that sets BOTH `temperature`
 * and `top_p` for Claude models ("temperature and top_p cannot both be specified
 * for this model. Please use only one."). Claude Code sends both, so keep
 * `temperature` — the sampling control Anthropic treats as primary, and the one
 * extended thinking pins to 1 — and drop `top_p`. Mutates `payload` in place.
 */
const reconcileSamplingParams = (payload: AnthropicMessagesPayload): void => {
  if (payload.temperature !== undefined && payload.top_p !== undefined) {
    delete payload.top_p
  }
}

/**
 * Copilot's native `/v1/messages` shim rejects unknown fields on tool
 * definitions with "Extra inputs are not permitted". Claude Code's fine-grained
 * tool streaming attaches `eager_input_streaming` to each tool, and the shim has
 * not adopted it, so strip it before forwarding. (opencode hits the same
 * rejection and disables the field at the SDK; here it arrives from the client,
 * so we remove it on the way through.) Mutates `payload` in place; a no-op when
 * the field is absent.
 */
const stripUnsupportedToolFields = (payload: AnthropicMessagesPayload): void => {
  if (!Array.isArray(payload.tools)) {
    return
  }
  for (const tool of payload.tools) {
    if (tool && typeof tool === "object" && "eager_input_streaming" in tool) {
      delete (tool as Record<string, unknown>).eager_input_streaming
    }
  }
}

/**
 * Strip assistant `thinking` blocks from the message history that Copilot's
 * native `/v1/messages` endpoint would reject with
 * `messages.<n>.content.<m>: Invalid signature in thinking block`.
 *
 * Faithful port of caozhiyuan/copilot-api's `filterAssistantThinkingBlocks`.
 * Only `role: "assistant"` messages with array content are touched; a thinking
 * block is kept only when ALL of the following hold (checked in this order):
 *   - `thinking` text is truthy,
 *   - it is not the `"Thinking..."` placeholder,
 *   - a `signature` is present, and
 *   - the signature does not contain `"@"`.
 * Every non-`thinking` block (text, tool_use, redacted_thinking, …) and every
 * non-assistant message passes through unchanged. Mutates `payload` in place.
 *
 * Without this, the verbatim passthrough replays a stale/unsigned/placeholder
 * thinking block from an earlier turn on every subsequent native call, 400ing
 * the whole request (the client then retries with the block pruned).
 */
const filterAssistantThinkingBlocks = (
  payload: AnthropicMessagesPayload,
): void => {
  for (const message of payload.messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue
    }
    message.content = message.content.filter((block) => {
      if (block.type !== "thinking") return true
      return Boolean(
        block.thinking
          && block.thinking !== THINKING_PLACEHOLDER
          && block.signature
          && !block.signature.includes("@"),
      )
    })
  }
}

/**
 * Sanitize an inbound Anthropic Messages payload for Copilot's native
 * `/v1/messages` endpoint according to the selected model's advertised
 * capabilities. Mutates `payload` in place.
 *
 * Faithful port of caozhiyuan/copilot-api's `prepareMessagesApiPayload`
 * (reasoning/thinking gating only — the upstream cache-control / eager-input /
 * thinking-block-filter helpers are separate concerns not ported here), plus a
 * `temperature`/`top_p` reconciliation and an unsupported-tool-field strip
 * Copilot's shim requires. Without this step the passthrough forwards
 * client-sent `thinking` / `output_config` / sampling params / tool fields
 * verbatim, which Copilot upstream rejects per-model, e.g.:
 *   - `output_config.effort "high" … claude-haiku-4.5 does not support
 *     reasoning effort` (a non-adaptive model receiving an effort hint), and
 *   - `"thinking.type.enabled" is not supported … Use "thinking.type.adaptive"`
 *     (an adaptive model receiving a legacy enabled-thinking block).
 *
 * Two capability branches (mutually exclusive on `adaptive_thinking`):
 *   - Adaptive: rewrite `thinking` to `{ type: "adaptive" }` (+ summarized
 *     display), resolve/normalize/snap the reasoning effort to the model's
 *     advertised list, and express it as `output_config = { effort }`.
 *   - Non-adaptive: drop `output_config.effort` when the model advertises no
 *     `reasoning_effort` list; drop thinking entirely when tools are forced;
 *     otherwise down-convert `adaptive` thinking to a concrete `enabled` budget.
 */
export const prepareMessagesApiPayload = (
  payload: AnthropicMessagesPayload,
  selectedModel?: Model,
): void => {
  // Drop history thinking blocks whose signature Copilot's native endpoint
  // rejects, independent of the reasoning-config gating below. Runs first so it
  // applies on every branch (adaptive, non-adaptive, and unknown-model).
  filterAssistantThinkingBlocks(payload)

  // Reconcile temperature/top_p and drop tool fields Copilot's shim rejects,
  // before any branch returns, so both apply to every model routed through the
  // native passthrough.
  reconcileSamplingParams(payload)
  stripUnsupportedToolFields(payload)

  // Whether the client sent any thinking config *before* we mutate it — gates
  // the default `display = "summarized"` in the adaptive branch.
  const hasThinking = Boolean(payload.thinking)

  // Copilot forces tool use for these tool_choice modes, which is incompatible
  // with extended thinking, so thinking is suppressed when either is set.
  const toolChoice = payload.tool_choice
  const disableThink =
    toolChoice?.type === "any" || toolChoice?.type === "tool"

  const supports = selectedModel?.capabilities.supports

  // Adaptive-thinking models: normalize to adaptive + effort-based output_config.
  if (supports?.adaptive_thinking && !disableThink) {
    payload.thinking = { type: "adaptive" }
    if (!hasThinking) {
      payload.thinking.display = "summarized"
    }
    if (shouldSummarizeThinkingDisplayForModel(payload.model)) {
      payload.thinking.display = "summarized"
    }

    let effort: ReasoningEffort =
      payload.output_config?.effort
      ?? getReasoningEffortForModel(payload.model)
    // Copilot's adaptive models don't accept the two lowest tiers; fold them up.
    if (effort === "none" || effort === "minimal") {
      effort = "low"
    }
    // Snap to the model's advertised ladder, defaulting to its highest level.
    const reasoningEffort = supports.reasoning_effort
    if (reasoningEffort && !reasoningEffort.includes(effort)) {
      effort = (reasoningEffort.at(-1) ?? effort) as ReasoningEffort
    }
    payload.output_config = { effort }
    return
  }

  // Non-adaptive models: strip fields they reject and down-convert thinking.
  if (!supports?.adaptive_thinking) {
    const reasoningEfforts = supports?.reasoning_effort
    if (!reasoningEfforts || reasoningEfforts.length === 0) {
      if (payload.output_config?.effort) {
        delete payload.output_config.effort
        if (Object.keys(payload.output_config).length === 0) {
          delete payload.output_config
        }
      }
    }

    if (disableThink) {
      delete payload.thinking
    } else if (payload.thinking?.type === "adaptive") {
      const budgetTokens = supports?.max_thinking_budget ?? 4096
      payload.thinking = { type: "enabled", budget_tokens: budgetTokens - 1 }
    }
  }
}
