import consola from "consola"

import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const enableVision = payload.messages.some(
    (x) =>
      typeof x.content !== "string"
      && x.content?.some((x) => x.type === "image_url"),
  )

  // Agent/user check for X-Initiator header
  // Determine if any message is from an agent ("assistant" or "tool")
  const isAgentCall = payload.messages.some((msg) =>
    ["assistant", "tool"].includes(msg.role),
  )

  // Build headers and add X-Initiator
  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    "X-Initiator": isAgentCall ? "agent" : "user",
  }

  const response = await fetch(`${copilotBaseUrl(state)}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    consola.error("Failed to create chat completions", response)
    throw new HTTPError("Failed to create chat completions", response)
  }

  if (payload.stream) {
    return response
  }

  return (await response.json()) as ChatCompletionResponse
}

// Streaming types

export interface ChatCompletionChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<Choice>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
    completion_tokens_details?: {
      accepted_prediction_tokens: number
      rejected_prediction_tokens: number
    }
  }
}

interface Delta {
  content?: string | null
  role?: "user" | "assistant" | "system" | "tool"
  tool_calls?: Array<{
    index: number
    id?: string
    type?: "function"
    function?: {
      name?: string
      arguments?: string
    }
  }>
  /**
   * Reasoning / "thinking" output streamed by reasoning-capable Copilot models.
   * Copilot's CAPI emits reasoning under several field names depending on the
   * upstream model (see the VS Code Copilot Chat extension's thinking.ts):
   *   - text:      cot_summary (Azure OpenAI) | reasoning_text (Copilot) | thinking (Anthropic)
   *   - id / sig:  cot_id (Azure OpenAI) | reasoning_opaque (Copilot) | signature (Anthropic)
   */
  cot_summary?: string | null
  cot_id?: string | null
  reasoning_text?: string | null
  reasoning_opaque?: string | null
  thinking?: string | null
  signature?: string | null
}

interface Choice {
  index: number
  delta: Delta
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
  logprobs: object | null
}

// Non-streaming types

export interface ChatCompletionResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: Array<ChoiceNonStreaming>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
  }
}

interface ResponseMessage {
  role: "assistant"
  content: string | null
  tool_calls?: Array<ToolCall>
  /**
   * Reasoning / "thinking" output for reasoning-capable models. See the Delta
   * type above for the field-name variants Copilot's CAPI uses.
   */
  cot_summary?: string | null
  cot_id?: string | null
  reasoning_text?: string | null
  reasoning_opaque?: string | null
  thinking?: string | null
  signature?: string | null
}

interface ChoiceNonStreaming {
  index: number
  message: ResponseMessage
  logprobs: object | null
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter"
}

// Payload types

export interface ChatCompletionsPayload {
  messages: Array<Message>
  model: string
  temperature?: number | null
  top_p?: number | null
  max_tokens?: number | null
  max_completion_tokens?: number | null
  stop?: string | Array<string> | null
  n?: number | null
  stream?: boolean | null

  frequency_penalty?: number | null
  presence_penalty?: number | null
  logit_bias?: Record<string, number> | null
  logprobs?: boolean | null
  response_format?: { type: "json_object" } | null
  seed?: number | null
  tools?: Array<Tool> | null
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } }
    | null
  user?: string | null

  /**
   * Reasoning effort level for reasoning-capable models (e.g. GPT-5, o-series,
   * Claude). Copilot's ChatCompletions API accepts this top-level field
   * directly. The accepted levels vary per model — validate against the
   * model's advertised `reasoning_effort` array before sending.
   */
  reasoning_effort?: ReasoningEffort | null
  /**
   * Thinking budget in tokens for Anthropic (Claude) models on the
   * ChatCompletions API. Mirrors the VS Code Copilot Chat extension, which
   * sends `thinking_budget` for Anthropic models on this endpoint.
   */
  thinking_budget?: number | null
}

/**
 * Reasoning effort levels accepted by reasoning-capable models.
 *
 * The exact set a given model accepts varies (e.g. Claude models accept
 * "max", OpenAI reasoning models accept "xhigh"), so callers should validate
 * a requested value against the model's advertised `reasoning_effort` array
 * rather than assuming all levels are universally supported. This union is the
 * superset observed in the VS Code Copilot Chat extension.
 */
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max"

export interface Tool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool" | "developer"
  content: string | Array<ContentPart> | null

  name?: string
  tool_calls?: Array<ToolCall>
  tool_call_id?: string
}

export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type ContentPart = TextPart | ImagePart

export interface TextPart {
  type: "text"
  text: string
}

export interface ImagePart {
  type: "image_url"
  image_url: {
    url: string
    detail?: "low" | "high" | "auto"
  }
}
