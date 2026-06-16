import { state } from "~/lib/state"
import {
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
  type ContentPart,
  type Message,
  type TextPart,
  type Tool,
  type ToolCall,
} from "~/services/copilot/create-chat-completions"

import {
  type AnthropicAssistantContentBlock,
  type AnthropicAssistantMessage,
  type AnthropicMessage,
  type AnthropicMessagesPayload,
  type AnthropicResponse,
  type AnthropicTextBlock,
  type AnthropicThinkingBlock,
  type AnthropicTool,
  type AnthropicToolResultBlock,
  type AnthropicToolUseBlock,
  type AnthropicUserContentBlock,
  type AnthropicUserMessage,
} from "./anthropic-types"
import { mapOpenAIStopReasonToAnthropic } from "./utils"

// Payload translation

export function translateToOpenAI(
  payload: AnthropicMessagesPayload,
): ChatCompletionsPayload {
  const model = translateModelName(payload.model)

  const openAIPayload: ChatCompletionsPayload = {
    model,
    messages: translateAnthropicMessagesToOpenAI(
      payload.messages,
      payload.system,
    ),
    max_tokens: payload.max_tokens,
    stop: payload.stop_sequences,
    stream: payload.stream,
    temperature: payload.temperature,
    top_p: payload.top_p,
    user: payload.metadata?.user_id,
    tools: translateAnthropicToolsToOpenAI(payload.tools),
    tool_choice: translateAnthropicToolChoiceToOpenAI(payload.tool_choice),
  }

  applyReasoningParams(openAIPayload, payload, model)

  return openAIPayload
}

/**
 * Maps Anthropic-style reasoning/thinking controls onto the OpenAI
 * ChatCompletions payload, but only when the *resolved* Copilot model actually
 * supports them. This mirrors the VS Code Copilot Chat extension, which sends:
 *   - `thinking_budget` (a token count) for Anthropic/Claude models, and
 *   - `reasoning_effort` (e.g. "low"|"medium"|"high"|"xhigh"|"max") for
 *     reasoning-capable models.
 *
 * The exact effort levels accepted vary per model, so the requested value is
 * validated against the model's advertised `reasoning_effort` array. Capability
 * gating avoids sending parameters that would make Copilot reject the request
 * with a 400 for models that don't support thinking.
 */
function applyReasoningParams(
  openAIPayload: ChatCompletionsPayload,
  payload: AnthropicMessagesPayload,
  model: string,
): void {
  const selectedModel = state.models?.data.find((m) => m.id === model)
  const supports = selectedModel?.capabilities.supports

  // If we don't know the model's capabilities, fall back to forwarding the
  // client's intent verbatim so newly-added models still work.
  const thinkingRequested =
    payload.thinking?.type === "enabled"
    || payload.thinking?.type === "adaptive"

  // 1) Reasoning effort (e.g. GPT-5 / o-series). Only send when the model
  //    advertises supported effort levels, and only the levels it accepts.
  const effortLevels = supports?.reasoning_effort
  const requestedEffort = payload.reasoning_effort
  if (requestedEffort) {
    const effortSupported =
      effortLevels === undefined || effortLevels.length === 0 ?
        // Unknown capabilities: forward as-is.
        selectedModel === undefined
      : effortLevels.includes(requestedEffort)
    if (effortSupported) {
      openAIPayload.reasoning_effort = requestedEffort
    }
  }

  // 2) Thinking budget for Claude-family models. Translate
  //    thinking.budget_tokens -> thinking_budget, clamped to the model's
  //    advertised [min, max] window when known.
  //
  //    Capability signal: upstream Copilot does NOT expose a `thinking`
  //    boolean — thinking support is indicated by `adaptive_thinking` or by the
  //    presence of a [min, max] thinking-budget window (mirroring the VS Code
  //    Copilot Chat extension, which gates on adaptiveThinking || (min && max)).
  const supportsThinking =
    supports === undefined ?
      selectedModel === undefined // unknown model: forward client intent as-is
    : Boolean(
        supports.adaptive_thinking
          || supports.max_thinking_budget
          || supports.min_thinking_budget,
      )
  if (thinkingRequested && supportsThinking) {
    const requestedBudget = payload.thinking?.budget_tokens
    if (typeof requestedBudget === "number" && requestedBudget > 0) {
      openAIPayload.thinking_budget = clampThinkingBudget(
        requestedBudget,
        supports?.min_thinking_budget,
        supports?.max_thinking_budget,
        payload.max_tokens,
      )
    }
  }
}

function clampThinkingBudget(
  requested: number,
  min: number | undefined,
  max: number | undefined,
  maxTokens: number | undefined,
): number {
  let budget = requested
  if (typeof min === "number" && budget < min) {
    budget = min
  }
  if (typeof max === "number" && budget > max) {
    budget = max
  }
  // The thinking budget must leave room for at least one output token.
  if (typeof maxTokens === "number" && maxTokens > 1 && budget > maxTokens - 1) {
    budget = maxTokens - 1
  }
  return budget
}

/**
 * Translates an Anthropic-style model identifier (as sent by Claude Code) into
 * the GitHub Copilot model ID format.
 *
 * Anthropic canonical IDs use dashes for the version and an optional date
 * suffix (e.g. `claude-sonnet-4-5-20250929`, `claude-opus-4-1-20250805`,
 * `claude-haiku-4-5-20251001`). Copilot uses dotted versions without a date
 * suffix (e.g. `claude-sonnet-4.5`, `claude-opus-4.1`, `claude-haiku-4.5`).
 *
 * Rules:
 * - Pass through any model id that already contains a dot — callers may
 *   already specify a Copilot-native id (e.g. `claude-sonnet-4.5`).
 * - Strip a trailing `-YYYYMMDD` date suffix.
 * - Handle the new `claude-<family>-<major>[-<minor>]` shape.
 * - Handle the legacy `claude-<major>-<minor>-<family>` shape (e.g.
 *   `claude-3-5-sonnet`).
 * - Otherwise return the original id unchanged and let Copilot decide.
 */
export function translateModelName(model: string): string {
  // Already a Copilot-style id (e.g. "claude-sonnet-4.5", "gpt-4.1"): pass
  // through untouched.
  if (model.includes(".")) {
    return model
  }

  // Strip trailing date stamp: "-20250929".
  const withoutDate = model.replace(/-\d{8}$/, "")

  // New Anthropic shape: claude-<family>-<major>[-<minor>].
  const newShape = /^claude-(sonnet|opus|haiku)-(\d+)(?:-(\d+))?$/.exec(
    withoutDate,
  )
  if (newShape) {
    const [, family, major, minor] = newShape
    const version = minor ? `${major}.${minor}` : major
    return `claude-${family}-${version}`
  }

  // Legacy Anthropic shape: claude-<major>-<minor>-<family>.
  const legacyShape = /^claude-(\d+)-(\d+)-(sonnet|opus|haiku)$/.exec(
    withoutDate,
  )
  if (legacyShape) {
    const [, major, minor, family] = legacyShape
    return `claude-${family}-${major}.${minor}`
  }

  return model
}

function translateAnthropicMessagesToOpenAI(
  anthropicMessages: Array<AnthropicMessage>,
  system: string | Array<AnthropicTextBlock> | undefined,
): Array<Message> {
  const systemMessages = handleSystemPrompt(system)

  const otherMessages = anthropicMessages.flatMap((message) =>
    message.role === "user" ?
      handleUserMessage(message)
    : handleAssistantMessage(message),
  )

  return [...systemMessages, ...otherMessages]
}

function handleSystemPrompt(
  system: string | Array<AnthropicTextBlock> | undefined,
): Array<Message> {
  if (!system) {
    return []
  }

  if (typeof system === "string") {
    return [{ role: "system", content: system }]
  } else {
    const systemText = system.map((block) => block.text).join("\n\n")
    return [{ role: "system", content: systemText }]
  }
}

function handleUserMessage(message: AnthropicUserMessage): Array<Message> {
  const newMessages: Array<Message> = []

  if (Array.isArray(message.content)) {
    const toolResultBlocks = message.content.filter(
      (block): block is AnthropicToolResultBlock =>
        block.type === "tool_result",
    )
    const otherBlocks = message.content.filter(
      (block) => block.type !== "tool_result",
    )

    // Tool results must come first to maintain protocol: tool_use -> tool_result -> user
    for (const block of toolResultBlocks) {
      newMessages.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: mapContent(block.content),
      })
    }

    if (otherBlocks.length > 0) {
      newMessages.push({
        role: "user",
        content: mapContent(otherBlocks),
      })
    }
  } else {
    newMessages.push({
      role: "user",
      content: mapContent(message.content),
    })
  }

  return newMessages
}

function handleAssistantMessage(
  message: AnthropicAssistantMessage,
): Array<Message> {
  if (!Array.isArray(message.content)) {
    return [
      {
        role: "assistant",
        content: mapContent(message.content),
      },
    ]
  }

  const toolUseBlocks = message.content.filter(
    (block): block is AnthropicToolUseBlock => block.type === "tool_use",
  )

  const textBlocks = message.content.filter(
    (block): block is AnthropicTextBlock => block.type === "text",
  )

  const thinkingBlocks = message.content.filter(
    (block): block is AnthropicThinkingBlock => block.type === "thinking",
  )

  // Combine text and thinking blocks, as OpenAI doesn't have separate thinking blocks
  const allTextContent = [
    ...textBlocks.map((b) => b.text),
    ...thinkingBlocks.map((b) => b.thinking),
  ].join("\n\n")

  return toolUseBlocks.length > 0 ?
      [
        {
          role: "assistant",
          content: allTextContent || null,
          tool_calls: toolUseBlocks.map((toolUse) => ({
            id: toolUse.id,
            type: "function",
            function: {
              name: toolUse.name,
              arguments: JSON.stringify(toolUse.input),
            },
          })),
        },
      ]
    : [
        {
          role: "assistant",
          content: mapContent(message.content),
        },
      ]
}

function mapContent(
  content:
    | string
    | Array<AnthropicUserContentBlock | AnthropicAssistantContentBlock>,
): string | Array<ContentPart> | null {
  if (typeof content === "string") {
    return content
  }
  if (!Array.isArray(content)) {
    return null
  }

  const hasImage = content.some((block) => block.type === "image")
  if (!hasImage) {
    return content
      .filter(
        (block): block is AnthropicTextBlock | AnthropicThinkingBlock =>
          block.type === "text" || block.type === "thinking",
      )
      .map((block) => (block.type === "text" ? block.text : block.thinking))
      .join("\n\n")
  }

  const contentParts: Array<ContentPart> = []
  for (const block of content) {
    switch (block.type) {
      case "text": {
        contentParts.push({ type: "text", text: block.text })

        break
      }
      case "thinking": {
        contentParts.push({ type: "text", text: block.thinking })

        break
      }
      case "image": {
        contentParts.push({
          type: "image_url",
          image_url: {
            url: `data:${block.source.media_type};base64,${block.source.data}`,
          },
        })

        break
      }
      // No default
    }
  }
  return contentParts
}

function translateAnthropicToolsToOpenAI(
  anthropicTools: Array<AnthropicTool> | undefined,
): Array<Tool> | undefined {
  if (!anthropicTools) {
    return undefined
  }
  return anthropicTools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }))
}

function translateAnthropicToolChoiceToOpenAI(
  anthropicToolChoice: AnthropicMessagesPayload["tool_choice"],
): ChatCompletionsPayload["tool_choice"] {
  if (!anthropicToolChoice) {
    return undefined
  }

  switch (anthropicToolChoice.type) {
    case "auto": {
      return "auto"
    }
    case "any": {
      return "required"
    }
    case "tool": {
      if (anthropicToolChoice.name) {
        return {
          type: "function",
          function: { name: anthropicToolChoice.name },
        }
      }
      return undefined
    }
    case "none": {
      return "none"
    }
    default: {
      return undefined
    }
  }
}

// Response translation

export function translateToAnthropic(
  response: ChatCompletionResponse,
): AnthropicResponse {
  // Merge content from all choices
  const allThinkingBlocks: Array<AnthropicThinkingBlock> = []
  const allTextBlocks: Array<AnthropicTextBlock> = []
  const allToolUseBlocks: Array<AnthropicToolUseBlock> = []
  let stopReason: "stop" | "length" | "tool_calls" | "content_filter" | null =
    null // default
  stopReason = response.choices[0]?.finish_reason ?? stopReason

  // Process all choices to extract thinking, text and tool use blocks
  for (const choice of response.choices) {
    const reasoningText = extractReasoningText(choice.message)
    if (reasoningText) {
      allThinkingBlocks.push({ type: "thinking", thinking: reasoningText })
    }

    const textBlocks = getAnthropicTextBlocks(choice.message.content)
    const toolUseBlocks = getAnthropicToolUseBlocks(choice.message.tool_calls)

    allTextBlocks.push(...textBlocks)
    allToolUseBlocks.push(...toolUseBlocks)

    // Use the finish_reason from the first choice, or prioritize tool_calls
    if (choice.finish_reason === "tool_calls" || stopReason === "stop") {
      stopReason = choice.finish_reason
    }
  }

  // Anthropic requires thinking blocks to precede text/tool_use blocks.
  return {
    id: response.id,
    type: "message",
    role: "assistant",
    model: response.model,
    content: [...allThinkingBlocks, ...allTextBlocks, ...allToolUseBlocks],
    stop_reason: mapOpenAIStopReasonToAnthropic(stopReason),
    stop_sequence: null,
    usage: {
      input_tokens:
        (response.usage?.prompt_tokens ?? 0)
        - (response.usage?.prompt_tokens_details?.cached_tokens ?? 0),
      output_tokens: response.usage?.completion_tokens ?? 0,
      ...(response.usage?.prompt_tokens_details?.cached_tokens
        !== undefined && {
        cache_read_input_tokens:
          response.usage.prompt_tokens_details.cached_tokens,
      }),
    },
  }
}

/**
 * Copilot's CAPI exposes reasoning output under several field names depending
 * on the upstream model/endpoint. This mirrors the priority order used by the
 * VS Code Copilot Chat extension (getThinkingDeltaText in thinkingUtils.ts):
 * cot_summary (Azure OpenAI) -> reasoning_text (Copilot) -> thinking (Anthropic).
 *
 * Accepts either a streaming `delta` or a non-streaming `message`, since the
 * extension reads thinking from `choice.message || choice.delta`.
 */
export function extractReasoningText(source: {
  cot_summary?: string | null
  reasoning_text?: string | null
  thinking?: string | null
}): string | undefined {
  const text = source.cot_summary ?? source.reasoning_text ?? source.thinking
  return text ? text : undefined
}

function getAnthropicTextBlocks(
  messageContent: Message["content"],
): Array<AnthropicTextBlock> {
  if (typeof messageContent === "string") {
    return [{ type: "text", text: messageContent }]
  }

  if (Array.isArray(messageContent)) {
    return messageContent
      .filter((part): part is TextPart => part.type === "text")
      .map((part) => ({ type: "text", text: part.text }))
  }

  return []
}

function getAnthropicToolUseBlocks(
  toolCalls: Array<ToolCall> | undefined,
): Array<AnthropicToolUseBlock> {
  if (!toolCalls) {
    return []
  }
  return toolCalls.map((toolCall) => ({
    type: "tool_use",
    id: toolCall.id,
    name: toolCall.function.name,
    input: JSON.parse(toolCall.function.arguments) as Record<string, unknown>,
  }))
}
