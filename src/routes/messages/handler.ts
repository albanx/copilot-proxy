import type { Context } from "hono"

import consola from "consola"
import { events } from "fetch-event-stream"
import { streamSSE } from "hono/streaming"

import { copilotBaseUrl } from "~/lib/api-config"
import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import {
  createChatCompletions,
  type ChatCompletionChunk,
} from "~/services/copilot/create-chat-completions"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import { translateChunkToAnthropicEvents } from "./stream-translation"

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  const openAIPayload = translateToOpenAI(anthropicPayload)
  consola.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(openAIPayload),
  )

  const selectedModel = state.models?.data.find(
    (model) => model.id === openAIPayload.model,
  )

  let tokenCount: { input: number; output: number } | undefined
  try {
    if (selectedModel) {
      tokenCount = await getTokenCount(openAIPayload, selectedModel)
    }
  } catch (error) {
    consola.warn("Failed to calculate token count:", error)
  }

  c.set("logInfo", {
    model: openAIPayload.model,
    sourceModel: anthropicPayload.model,
    upstream: `${copilotBaseUrl(state)}/chat/completions`,
    stream: openAIPayload.stream ?? false,
    messages: openAIPayload.messages.length,
    tools: openAIPayload.tools?.length ?? 0,
    responseFormat:
      openAIPayload.stream ? "sse" : (
        (openAIPayload.response_format?.type ?? "json")
      ),
    account: state.accountType,
    inputTokens: tokenCount?.input,
    outputTokens: tokenCount?.output,
    // Surface the reasoning params actually applied (post capability-gating)
    // plus the resolved model's context window, so they're visible per-request.
    reasoningEffort: openAIPayload.reasoning_effort ?? undefined,
    thinkingBudget: openAIPayload.thinking_budget ?? undefined,
    contextWindow:
      selectedModel?.capabilities.limits?.max_context_window_tokens,
  })

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await createChatCompletions(openAIPayload)

  // Streaming: response is a raw fetch Response
  if (response instanceof Response) {
    consola.debug("Streaming response from Copilot")
    return streamSSE(c, async (stream) => {
      const streamState: AnthropicStreamState = {
        messageStartSent: false,
        contentBlockIndex: 0,
        contentBlockOpen: false,
        thinkingBlockOpen: false,
        toolCalls: {},
      }

      for await (const rawEvent of events(response)) {
        consola.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
        if (rawEvent.data === "[DONE]") {
          break
        }

        if (!rawEvent.data) {
          continue
        }

        const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
        const sseEvents = translateChunkToAnthropicEvents(chunk, streamState)

        for (const event of sseEvents) {
          consola.debug("Translated Anthropic event:", JSON.stringify(event))
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          })
        }
      }
    })
  }

  // Non-streaming: response is a parsed JSON object
  consola.debug(
    "Non-streaming response from Copilot:",
    JSON.stringify(response).slice(-400),
  )
  const anthropicResponse = translateToAnthropic(response)
  consola.debug(
    "Translated Anthropic response:",
    JSON.stringify(anthropicResponse),
  )
  return c.json(anthropicResponse)
}
