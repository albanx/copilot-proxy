import type { Context } from "hono"

import consola from "consola"
import { events } from "fetch-event-stream"
import { streamSSE } from "hono/streaming"

import { copilotBaseUrl } from "~/lib/api-config"
import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { type Model } from "~/services/copilot/get-models"
import {
  createResponses,
  sanitizePayload,
  type ResponsesPayload,
} from "~/services/copilot/create-responses"

const RESPONSES_ENDPOINT = "/responses"

/**
 * Decide whether a model may be routed to Copilot's `/responses` endpoint.
 *
 * The check is intentionally permissive: it only rejects when the model is known
 * AND advertises an explicit `supported_endpoints` list that excludes
 * `/responses`. When the model is unknown (list not loaded) or advertises no
 * endpoints, we allow the request through and let upstream be the final arbiter —
 * avoiding false negatives for deployments that don't populate the field.
 */
export function modelSupportsResponses(model: Model | undefined): boolean {
  const endpoints = model?.supported_endpoints
  if (endpoints && endpoints.length > 0) {
    return endpoints.includes(RESPONSES_ENDPOINT)
  }
  return true
}

export async function handleResponses(c: Context) {
  await checkRateLimit(state)

  const rawPayload = await c.req.json<ResponsesPayload>()
  consola.debug(
    "Responses API request payload:",
    JSON.stringify(rawPayload).slice(-400),
  )

  const payload = sanitizePayload(rawPayload)

  // Capability guard: fail fast with a clean 400 when the resolved model
  // explicitly does not advertise `/responses`. This turns an opaque upstream
  // rejection into an actionable client error naming the offending model.
  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )
  if (!modelSupportsResponses(selectedModel)) {
    consola.warn(
      `Model ${payload.model} does not support the /responses endpoint`,
    )
    return c.json(
      {
        error: {
          message: `The model \`${payload.model}\` does not support the /responses endpoint.`,
          type: "invalid_request_error",
          code: "model_not_supported",
        },
      },
      400,
    )
  }

  c.set("logInfo", {
    model: payload.model,
    upstream: `${copilotBaseUrl(state)}/responses`,
    stream: payload.stream ?? false,
    responseFormat: payload.stream ? "sse" : "json",
    account: state.accountType,
  })

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await createResponses(payload)

  // Streaming: response is a raw fetch Response — re-emit each SSE event,
  // preserving the semantic event name (response.output_text.delta, etc.)
  // so Responses-API clients that dispatch on `event:` work correctly.
  if (response instanceof Response) {
    consola.debug("Streaming response from Copilot /responses")
    return streamSSE(c, async (stream) => {
      for await (const rawEvent of events(response)) {
        if (rawEvent.data === "[DONE]") {
          break
        }
        if (!rawEvent.data) {
          continue
        }
        const parsed = JSON.parse(rawEvent.data) as { type?: string }
        await stream.writeSSE({
          event: parsed.type ?? "message",
          data: rawEvent.data,
        })
      }
    })
  }

  // Non-streaming: response is a parsed JSON object — forward verbatim.
  consola.debug(
    "Non-streaming response from Copilot /responses:",
    JSON.stringify(response).slice(-400),
  )
  return c.json(response)
}
