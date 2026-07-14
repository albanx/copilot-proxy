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
  type ResponsesPayload,
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
 * Clamp the resolved reasoning effort to the model's advertised
 * `reasoning_effort` ladder (same convention as the native `/v1/messages`
 * preprocessor): fold the two lowest tiers up to "low", and snap anything the
 * model doesn't accept to its highest advertised level. Models that advertise
 * no ladder keep the requested effort untouched (upstream ignores it there).
 */
const snapReasoningEffortToModel = (
  responsesPayload: ResponsesPayload,
  selectedModel?: Model,
): void => {
  const reasoning = responsesPayload.reasoning
  if (!reasoning?.effort) {
    return
  }

  if (reasoning.effort === "none" || reasoning.effort === "minimal") {
    reasoning.effort = "low"
  }

  const effortLevels = selectedModel?.capabilities.supports?.reasoning_effort
  if (
    effortLevels
    && effortLevels.length > 0
    && !effortLevels.includes(reasoning.effort)
  ) {
    const snapped = effortLevels.at(-1) as typeof reasoning.effort
    consola.debug(
      `Requested reasoning effort "${reasoning.effort}" not supported by ${responsesPayload.model}; snapping to "${snapped}"`,
    )
    reasoning.effort = snapped
  }
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

  snapReasoningEffortToModel(responsesPayload, selectedModel)

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
      const streamStart = Date.now()
      let firstEventAt: number | undefined
      let finalUsage:
        | {
            input_tokens?: number
            output_tokens: number
            cache_read_input_tokens?: number
            cache_creation_input_tokens?: number
          }
        | undefined
      let stopReason: string | undefined

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
          if (firstEventAt === undefined) {
            firstEventAt = Date.now()
            consola.info(
              `TTFT: ${firstEventAt - streamStart}ms (${responsesPayload.model}, effort=${responsesPayload.reasoning?.effort ?? "-"})`,
            )
          }
          if (event.type === "message_delta") {
            finalUsage = event.usage ?? finalUsage
            stopReason = event.delta.stop_reason ?? stopReason
          }
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

      // The request-logger middleware has already printed its line by the time
      // usage arrives mid-stream, so emit the stream summary separately.
      const usageSummary =
        finalUsage ?
          ` tokens=${finalUsage.input_tokens ?? "?"}/${finalUsage.output_tokens} cache=${finalUsage.cache_read_input_tokens ?? 0}r/${finalUsage.cache_creation_input_tokens ?? 0}w`
        : ""
      consola.info(
        `Stream complete: ${responsesPayload.model} ${Date.now() - streamStart}ms stop=${stopReason ?? "?"}${usageSummary}`,
      )

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
  logInfo.cacheReadTokens = anthropicResponse.usage.cache_read_input_tokens
  logInfo.cacheWriteTokens = anthropicResponse.usage.cache_creation_input_tokens
  logInfo.stopReason = anthropicResponse.stop_reason ?? undefined
  consola.debug(
    "Translated Anthropic response:",
    JSON.stringify(anthropicResponse),
  )
  return c.json(anthropicResponse)
}
