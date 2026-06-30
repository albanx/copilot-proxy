import consola from "consola"

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
