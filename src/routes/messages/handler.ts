import type { Context } from "hono"

import consola from "consola"
import { events } from "fetch-event-stream"
import { streamSSE } from "hono/streaming"

import { copilotBaseUrl } from "~/lib/api-config"
import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { type RequestLogInfo } from "~/lib/request-logger"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { getResponsesTransportForModel } from "~/routes/responses/utils"
import {
  createChatCompletions,
  type ChatCompletionChunk,
} from "~/services/copilot/create-chat-completions"
import {
  createMessages,
  supportsAnthropicMessages,
} from "~/services/copilot/create-messages"

import {
  type AnthropicMessagesPayload,
  type AnthropicResponse,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  translateModelName,
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import { prepareMessagesApiPayload } from "./preprocess"
import { handleWithResponsesApi } from "./responses-flow"
import { translateChunkToAnthropicEvents } from "./stream-translation"

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  if (state.manualApprove) {
    await awaitApproval()
  }

  // Resolve the Copilot model id and its advertised capabilities so we can
  // decide whether to forward natively (Anthropic /v1/messages) or translate.
  const copilotModelId = translateModelName(anthropicPayload.model)
  const selectedModel = state.models?.data.find(
    (model) => model.id === copilotModelId,
  )

  // Native passthrough for models that speak the Anthropic Messages API. This
  // preserves Anthropic-only features (notably assistant-message prefill) that
  // the /chat/completions translation cannot express and would 400 on.
  if (supportsAnthropicMessages(selectedModel, copilotModelId)) {
    return handleNativeMessages(c, anthropicPayload, copilotModelId)
  }

  // Second preference: models that advertise the OpenAI `/responses` endpoint
  // but not native `/v1/messages`. Translate to a Responses payload and back to
  // Anthropic, preserving reasoning/thinking and tool semantics that the
  // `/chat/completions` fallback below would lose.
  if (getResponsesTransportForModel(selectedModel) != null) {
    return handleWithResponsesApi(c, anthropicPayload, { selectedModel })
  }

  return handleTranslatedCompletion(c, anthropicPayload)
}

/**
 * Forward the request to Copilot's native `/v1/messages` and re-emit its
 * Anthropic SSE events verbatim (preserving semantic `event:` names) so
 * Claude-Code-style clients receive an untouched Anthropic response — including
 * prefill continuations. Mirrors the Responses passthrough handler.
 */
async function handleNativeMessages(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  copilotModelId: string,
) {
  const payload: AnthropicMessagesPayload = {
    ...anthropicPayload,
    model: copilotModelId,
  }

  const selectedModel = state.models?.data.find(
    (model) => model.id === copilotModelId,
  )

  // Sanitize thinking / output_config per the model's advertised capabilities
  // before the verbatim passthrough. Copilot upstream rejects client-sent
  // reasoning params that a given model doesn't support (e.g. output_config.effort
  // on claude-haiku-4.5, or thinking.type "enabled" on adaptive-only models), so
  // this rewrites them in place to the shape each model accepts.
  prepareMessagesApiPayload(payload, selectedModel)

  const logInfo: RequestLogInfo = {
    model: copilotModelId,
    sourceModel: anthropicPayload.model,
    upstream: `${copilotBaseUrl(state)}/v1/messages`,
    stream: payload.stream ?? false,
    messages: payload.messages.length,
    tools: payload.tools?.length ?? 0,
    responseFormat: payload.stream ? "sse" : "json",
    account: state.accountType,
    // Post-preprocess values: what is actually sent upstream after capability
    // gating, not what the client originally asked for.
    reasoningEffort: payload.output_config?.effort ?? undefined,
    thinkingBudget: payload.thinking?.budget_tokens ?? undefined,
    contextWindow:
      selectedModel?.capabilities.limits?.max_context_window_tokens,
  }
  c.set("logInfo", logInfo)

  const response = await createMessages(payload, {
    anthropicBeta: c.req.header("anthropic-beta"),
  })

  // Streaming: response is a raw fetch Response emitting Anthropic SSE events.
  if (response instanceof Response) {
    consola.debug("Streaming response from Copilot /v1/messages")
    return streamSSE(c, async (stream) => {
      const streamStart = Date.now()
      let usageSummary = ""
      let stopReason: string | undefined

      for await (const rawEvent of events(response)) {
        if (rawEvent.data === "[DONE]") {
          break
        }
        if (!rawEvent.data) {
          continue
        }
        const parsed = JSON.parse(rawEvent.data) as {
          type?: string
          delta?: { stop_reason?: string | null }
          usage?: {
            input_tokens?: number
            output_tokens?: number
            cache_read_input_tokens?: number
            cache_creation_input_tokens?: number
          }
        }
        if (parsed.type === "message_delta") {
          const usage = parsed.usage
          if (usage) {
            usageSummary = ` tokens=${usage.input_tokens ?? "?"}/${usage.output_tokens ?? 0} cache=${usage.cache_read_input_tokens ?? 0}r/${usage.cache_creation_input_tokens ?? 0}w`
          }
          stopReason = parsed.delta?.stop_reason ?? stopReason
        }
        await stream.writeSSE({
          event: parsed.type ?? "message",
          data: rawEvent.data,
        })
      }

      consola.info(
        `Stream complete: ${copilotModelId} ${Date.now() - streamStart}ms stop=${stopReason ?? "?"}${usageSummary}`,
      )
    })
  }

  // Non-streaming: response is a parsed Anthropic JSON object — forward verbatim.
  consola.debug(
    "Non-streaming response from Copilot /v1/messages:",
    JSON.stringify(response).slice(-400),
  )
  const usage = (response as { usage?: AnthropicResponse["usage"] }).usage
  if (usage) {
    logInfo.inputTokens = usage.input_tokens
    logInfo.outputTokens = usage.output_tokens
    logInfo.cacheReadTokens = usage.cache_read_input_tokens
    logInfo.cacheWriteTokens = usage.cache_creation_input_tokens
  }
  return c.json(response)
}

/**
 * Legacy path: translate the Anthropic request to OpenAI `/chat/completions`
 * and translate the response back. Used for models that do not advertise (and
 * are not heuristically detected as supporting) the native Messages API.
 */
async function handleTranslatedCompletion(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
) {
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
