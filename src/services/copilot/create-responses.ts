import consola from "consola"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export interface ResponsesInputItem {
  type?: string
  role?: string
  content?: unknown
  [key: string]: unknown
}

export interface ResponsesTool {
  type?: string
  [key: string]: unknown
}

export interface ResponsesPayload {
  model: string
  input: string | Array<ResponsesInputItem>
  instructions?: string | null
  max_output_tokens?: number | null
  stream?: boolean | null
  tools?: Array<ResponsesTool> | null
  tool_choice?: unknown
  reasoning?: { effort?: string } | null
  [key: string]: unknown
}

/**
 * Decide the X-Initiator header value. Mirrors the chat-completions rule
 * (agent when history contains assistant/tool turns) adapted to the Responses
 * `input` shape: the Chat Completions `tool` role maps to the Responses
 * `function_call` / `function_call_output` items.
 */
export function initiator(payload: ResponsesPayload): "agent" | "user" {
  const { input } = payload
  if (!Array.isArray(input)) return "user"
  const isAgent = (input as Array<unknown>).some((item) => {
    if (typeof item !== "object" || item === null) return false
    const it = item as ResponsesInputItem
    return (
      it.role === "assistant"
      || it.type === "function_call"
      || it.type === "function_call_output"
    )
  })
  return isAgent ? "agent" : "user"
}

/** Best-effort scan for image content so we can set the copilot-vision header. */
export function detectVision(payload: ResponsesPayload): boolean {
  const { input } = payload
  if (!Array.isArray(input)) return false
  return (input as Array<unknown>).some((item) => {
    if (typeof item !== "object" || item === null) return false
    const content = (item as ResponsesInputItem).content
    if (!Array.isArray(content)) return false
    return content.some(
      (part) =>
        typeof part === "object"
        && part !== null
        && (part as { type?: string }).type === "input_image",
    )
  })
}

/**
 * Copilot's /responses only accepts `type: "function"` tools. Strip any built-in
 * tools (web_search, file_search, code_interpreter, computer_use_preview, …).
 * When no function tools remain, drop both `tools` and a dangling `tool_choice`
 * so upstream doesn't error on e.g. tool_choice:"required" with no tools.
 */
export function sanitizePayload(payload: ResponsesPayload): ResponsesPayload {
  if (!Array.isArray(payload.tools)) return payload

  const supportedTools = payload.tools.filter((tool) => tool.type === "function")
  const stripped = payload.tools.length - supportedTools.length
  if (stripped > 0) {
    consola.debug(`Stripped ${stripped} unsupported tool(s) from request`)
  }

  if (supportedTools.length > 0) {
    return { ...payload, tools: supportedTools }
  }

  const next = { ...payload }
  delete next.tools
  delete next.tool_choice
  return next
}

/**
 * Forward a Responses-format payload to Copilot upstream `/responses`.
 * Returns the raw streaming `Response` when `payload.stream` is set (the handler
 * iterates it via `events()` — mirrors the messages handler); otherwise returns
 * the parsed JSON object.
 */
export const createResponses = async (
  payload: ResponsesPayload,
): Promise<Response | Record<string, unknown>> => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const headers: Record<string, string> = {
    ...copilotHeaders(state, detectVision(payload)),
    "X-Initiator": initiator(payload),
  }

  const response = await fetch(`${copilotBaseUrl(state)}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    consola.error("Failed to create responses", response)
    throw new HTTPError("Failed to create responses", response)
  }

  if (payload.stream) {
    return response
  }

  return (await response.json()) as Record<string, unknown>
}
