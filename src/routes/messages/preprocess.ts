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
 * Sanitize an inbound Anthropic Messages payload for Copilot's native
 * `/v1/messages` endpoint according to the selected model's advertised
 * capabilities. Mutates `payload` in place.
 *
 * Faithful port of caozhiyuan/copilot-api's `prepareMessagesApiPayload`
 * (reasoning/thinking gating only — the upstream cache-control / eager-input /
 * thinking-block-filter helpers are separate concerns not ported here). Without
 * this step the passthrough forwards client-sent `thinking` / `output_config`
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
