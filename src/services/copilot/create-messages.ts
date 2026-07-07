import consola from "consola"

import {
  copilotBaseUrl,
  copilotHeaders,
  prepareMessageProxyHeaders,
} from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { parseUserIdMetadata } from "~/lib/utils"
import {
  type AnthropicMessage,
  type AnthropicMessagesPayload,
  type AnthropicResponse,
} from "~/routes/messages/anthropic-types"

import { type Model } from "./get-models"

/**
 * Decide the X-Initiator header value for a native Anthropic Messages request.
 * Mirrors the chat-completions rule (agent when the history contains an
 * assistant or tool turn) adapted to the Anthropic shape: the Chat Completions
 * `tool` role maps to Anthropic `tool_result` blocks nested inside a `user`
 * message.
 */
export function initiator(payload: AnthropicMessagesPayload): "agent" | "user" {
  const { messages } = payload
  if (!Array.isArray(messages)) return "user"

  const isAgent = messages.some((message) => {
    if (typeof message !== "object" || message === null) return false
    if (message.role === "assistant") return true

    const { content } = message as AnthropicMessage
    return (
      Array.isArray(content)
      && content.some(
        (block) =>
          typeof block === "object"
          && block !== null
          && (block as { type?: string }).type === "tool_result",
      )
    )
  })

  return isAgent ? "agent" : "user"
}

/** Best-effort scan for image content so we can set the copilot-vision header. */
export function detectVision(payload: AnthropicMessagesPayload): boolean {
  const { messages } = payload
  if (!Array.isArray(messages)) return false

  return messages.some((message) => {
    if (typeof message !== "object" || message === null) return false
    const { content } = message as AnthropicMessage
    if (!Array.isArray(content)) return false
    return content.some(
      (block) =>
        typeof block === "object"
        && block !== null
        && (block as { type?: string }).type === "image",
    )
  })
}

/**
 * Decide whether a request should be forwarded to Copilot's native
 * `/v1/messages` endpoint (which supports assistant-message prefill and other
 * Anthropic-only features) instead of being translated to `/chat/completions`.
 *
 * Preference order:
 *  1. Trust the model's advertised `supported_endpoints` when present.
 *  2. Otherwise fall back to a vendor/id heuristic — Copilot re-hosts Anthropic
 *     models that natively speak the Messages API, so `vendor === "anthropic"`
 *     or a `claude-` id prefix indicates Messages support. This also covers the
 *     case where the model list has not loaded yet (`model` is undefined).
 */
export function supportsAnthropicMessages(
  model: Model | undefined,
  modelId: string,
): boolean {
  const endpoints = model?.supported_endpoints
  if (endpoints && endpoints.length > 0) {
    return endpoints.includes("/v1/messages")
  }

  if (model?.vendor && model.vendor.toLowerCase() === "anthropic") {
    return true
  }

  return modelId.startsWith("claude-")
}

/**
 * Beta flags the VS Code Copilot Chat extension is willing to forward on the
 * native Messages passthrough. Anything a client sends outside this set is
 * dropped so we never opt Copilot's upstream into an unsupported beta.
 */
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14"
const allowedAnthropicBetas = new Set([
  INTERLEAVED_THINKING_BETA,
  "context-management-2025-06-27",
  "advanced-tool-use-2025-11-20",
])

/**
 * Build the `anthropic-beta` header for a native `/v1/messages` request.
 *
 * Preference order (mirrors the VS Code Copilot Chat extension):
 *  1. If the client sent an inbound `anthropic-beta` header, forward only the
 *     allow-listed flags it contains (dropping anything unknown). If none
 *     survive filtering, send no beta header.
 *  2. Otherwise derive `interleaved-thinking` when the client requested a
 *     concrete (non-adaptive) thinking budget.
 *
 * Kept deliberately conservative so the common (non-thinking) case stays a pure
 * passthrough with no extra beta flags.
 */
export function buildAnthropicBetaHeader(
  payload: AnthropicMessagesPayload,
  inboundBeta?: string,
): string | undefined {
  if (inboundBeta) {
    const filtered = inboundBeta
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .filter((item) => allowedAnthropicBetas.has(item))
    return filtered.length > 0 ? filtered.join(",") : undefined
  }

  const { thinking } = payload
  const isAdaptiveThinking = thinking?.type === "adaptive"
  if (thinking?.budget_tokens && !isAdaptiveThinking) {
    return INTERLEAVED_THINKING_BETA
  }

  return undefined
}

/**
 * Options controlling native passthrough header derivation.
 */
export interface CreateMessagesOptions {
  /** Inbound `anthropic-beta` request header, forwarded via the allow-list. */
  anthropicBeta?: string
}

/**
 * Forward an Anthropic Messages payload to Copilot upstream `/v1/messages`.
 * Returns the raw streaming `Response` when `payload.stream` is set (the handler
 * iterates it via `events()` and re-emits each Anthropic SSE event verbatim);
 * otherwise returns the parsed Anthropic JSON response.
 *
 * Because this is a native passthrough, requests that end with a trailing
 * `assistant` turn (prefill) reach an endpoint that accepts them — unlike the
 * `/chat/completions` translation, which rejects such conversations with a 400
 * "does not support assistant message prefill".
 */
export const createMessages = async (
  payload: AnthropicMessagesPayload,
  options: CreateMessagesOptions = {},
): Promise<Response | AnthropicResponse> => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const headers: Record<string, string> = {
    ...copilotHeaders(state, detectVision(payload)),
    "X-Initiator": initiator(payload),
  }

  // Copilot's upstream WAF only accepts the native Anthropic passthrough when a
  // Claude-Code-originated request presents the "messages-proxy" identity. We
  // detect Claude Code by the safetyIdentifier+sessionId pair it encodes in
  // metadata.user_id. claude-opus-4.8 is excluded: on that model id the same
  // header set triggers a 403 "Access to this endpoint is forbidden", while the
  // default Copilot identity (copilot-integration-id: vscode-chat) is accepted —
  // a model-id rollout gap on Copilot's side. Remove the skip once upstream
  // accepts the Claude-Code identity on 4.8.
  const { safetyIdentifier, sessionId } = parseUserIdMetadata(
    payload.metadata?.user_id,
  )
  if (safetyIdentifier && sessionId && payload.model !== "claude-opus-4.8") {
    prepareMessageProxyHeaders(headers)
  }

  const beta = buildAnthropicBetaHeader(payload, options.anthropicBeta)
  if (beta) headers["anthropic-beta"] = beta

  const response = await fetch(`${copilotBaseUrl(state)}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    consola.error("Failed to create messages", response)
    throw new HTTPError("Failed to create messages", response)
  }

  if (payload.stream) {
    return response
  }

  return (await response.json()) as AnthropicResponse
}
