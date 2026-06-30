import type { Context } from "hono"

import consola from "consola"
import { events } from "fetch-event-stream"
import { streamSSE } from "hono/streaming"

import { copilotBaseUrl } from "~/lib/api-config"
import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  createResponses,
  sanitizePayload,
  type ResponsesPayload,
} from "~/services/copilot/create-responses"

export async function handleResponses(c: Context) {
  await checkRateLimit(state)

  const rawPayload = await c.req.json<ResponsesPayload>()
  consola.debug(
    "Responses API request payload:",
    JSON.stringify(rawPayload).slice(-400),
  )

  const payload = sanitizePayload(rawPayload)

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
