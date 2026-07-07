import type { Context } from "hono"

import consola from "consola"
import { events } from "fetch-event-stream"
import { streamSSE } from "hono/streaming"

import { copilotBaseUrl } from "~/lib/api-config"
import { type RequestLogInfo } from "~/lib/request-logger"
import { state } from "~/lib/state"
import { resolveBridgeToolSearchName } from "~/lib/tool-search"
import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
} from "~/routes/responses/utils"
import {
  createResponses,
  type ResponsesPayload as LocalResponsesPayload,
} from "~/services/copilot/create-responses"
import {
  type ResponsesResult,
  type ResponseStreamEvent,
} from "~/services/copilot/create-responses-types"
import { type Model } from "~/services/copilot/get-models"

import { type AnthropicMessagesPayload } from "./anthropic-types"
import {
  buildErrorEvent,
  createResponsesStreamState,
  translateResponsesStreamEvent,
} from "./responses-stream-translation"
import {
  translateAnthropicMessagesToResponsesPayload,
  translateResponsesResultToAnthropic,
} from "./responses-translation"

interface ResponsesFlowOptions {
  selectedModel?: Model
}

/**
 * Third routing branch for inbound Anthropic `/v1/messages` requests: translate
 * to an OpenAI Responses payload, forward to Copilot's `/responses`, and
 * translate the result back to Anthropic (streaming SSE + non-streaming JSON).
 *
 * Trimmed re-author of caozhiyuan/copilot-api's `handleWithResponsesApi`,
 * adapted to this proxy's integration seam:
 *   - the local `createResponses` is 1-arg (vision/initiator/`X-Initiator` are
 *     computed inside it), so we neither compute nor re-pass request options;
 *   - streaming returns a raw fetch `Response` which we wrap with `events()` to
 *     reconstruct the `{ event, data }` async-iterable the stream translator
 *     expects (mirrors the native `/v1/messages` handler);
 *   - `capabilities.limits` is optional locally, so the compaction threshold
 *     reads through `?.max_prompt_tokens`;
 *   - token-usage recording is a no-op in this proxy and is therefore omitted.
 */
export const handleWithResponsesApi = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options: ResponsesFlowOptions,
) => {
  const { selectedModel } = options

  const responsesPayload =
    translateAnthropicMessagesToResponsesPayload(anthropicPayload)

  applyResponsesApiContextManagement(
    responsesPayload,
    selectedModel?.capabilities.limits?.max_prompt_tokens,
  )

  compactInputByLatestCompaction(responsesPayload)

  consola.debug(
    "Translated Responses payload:",
    JSON.stringify(responsesPayload).slice(0, 2000),
  )

  // Held in a typed local so the non-streaming branch can backfill token counts
  // before the request-logger middleware reads `logInfo` (after `next()`).
  const logInfo: RequestLogInfo = {
    model: responsesPayload.model,
    sourceModel: anthropicPayload.model,
    upstream: `${copilotBaseUrl(state)}/responses`,
    stream: responsesPayload.stream ?? false,
    messages: anthropicPayload.messages.length,
    tools: anthropicPayload.tools?.length ?? 0,
    responseFormat: responsesPayload.stream ? "sse" : "json",
    account: state.accountType,
    reasoningEffort: responsesPayload.reasoning?.effort ?? undefined,
    contextWindow:
      selectedModel?.capabilities.limits?.max_context_window_tokens,
  }
  c.set("logInfo", logInfo)

  const toolSearchName = resolveBridgeToolSearchName(anthropicPayload.tools)

  const response = await createResponses(
    responsesPayload as unknown as LocalResponsesPayload,
  )

  // Streaming: the local service returns a raw fetch Response emitting Responses
  // SSE events. Wrap it with `events()` to recover the `{ event, data }` shape.
  if (responsesPayload.stream && response instanceof Response) {
    consola.debug("Streaming response from Copilot (Responses API)")
    return streamSSE(c, async (stream) => {
      const streamState = createResponsesStreamState({ toolSearchName })

      for await (const chunk of events(response)) {
        const eventName = chunk.event
        if (eventName === "ping") {
          await stream.writeSSE({ event: "ping", data: '{"type":"ping"}' })
          continue
        }

        const data = chunk.data
        if (!data) {
          continue
        }

        const responseEvent = JSON.parse(data) as ResponseStreamEvent
        const translatedEvents = translateResponsesStreamEvent(
          responseEvent,
          streamState,
        )
        for (const event of translatedEvents) {
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          })
        }

        if (streamState.messageCompleted) {
          consola.debug("Message completed, ending stream")
          break
        }
      }

      if (!streamState.messageCompleted) {
        consola.warn(
          "Responses stream ended without completion; sending error event",
        )
        const errorEvent = buildErrorEvent(
          "Responses stream ended without completion",
        )
        await stream.writeSSE({
          event: errorEvent.type,
          data: JSON.stringify(errorEvent),
        })
      }
    })
  }

  // Non-streaming: the parsed object is the Responses result.
  consola.debug(
    "Non-streaming Responses result:",
    JSON.stringify(response).slice(-400),
  )
  const anthropicResponse = translateResponsesResultToAnthropic(
    response as unknown as ResponsesResult,
    { toolSearchName },
  )
  // Backfill token counts so the request-logger summary line reports usage for
  // the non-streaming path (streaming usage is only known mid-stream and can
  // never reach the middleware).
  logInfo.inputTokens = anthropicResponse.usage.input_tokens
  logInfo.outputTokens = anthropicResponse.usage.output_tokens
  consola.debug(
    "Translated Anthropic response:",
    JSON.stringify(anthropicResponse),
  )
  return c.json(anthropicResponse)
}
