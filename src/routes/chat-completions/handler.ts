import type { Context } from "hono"

import consola from "consola"

import { copilotBaseUrl } from "~/lib/api-config"
import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { isNullish } from "~/lib/utils"
import {
  createChatCompletions,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

function buildLogInfo(
  payload: ChatCompletionsPayload,
  tokens?: { input: number; output: number },
) {
  return {
    model: payload.model,
    upstream: `${copilotBaseUrl(state)}/chat/completions`,
    stream: payload.stream ?? false,
    messages: payload.messages.length,
    tools: payload.tools?.length ?? 0,
    responseFormat:
      payload.stream ? "sse" : (payload.response_format?.type ?? "json"),
    account: state.accountType,
    inputTokens: tokens?.input,
    outputTokens: tokens?.output,
  }
}

function normalizeMaxTokens(
  payload: ChatCompletionsPayload,
  selectedModel:
    | { capabilities: { limits: { max_output_tokens?: number } } }
    | undefined,
) {
  const payloadAny = payload as unknown as Record<string, unknown>
  if (!isNullish(payloadAny.max_completion_tokens)) {
    delete payloadAny.max_tokens
    consola.debug(
      "Using max_completion_tokens:",
      payloadAny.max_completion_tokens,
    )
    return
  }
  if (!isNullish(payload.max_tokens)) {
    payloadAny.max_completion_tokens = payload.max_tokens
    delete payloadAny.max_tokens
    consola.debug(
      "Normalized max_tokens to max_completion_tokens:",
      payloadAny.max_completion_tokens,
    )
    return
  }
  payloadAny.max_completion_tokens =
    selectedModel?.capabilities.limits.max_output_tokens
  consola.debug(
    "Set max_completion_tokens to:",
    JSON.stringify(payloadAny.max_completion_tokens),
  )
}

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const payload = await c.req.json<ChatCompletionsPayload>()
  consola.debug("Request payload:", JSON.stringify(payload).slice(-400))

  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )

  let tokenCount: { input: number; output: number } | undefined
  try {
    if (selectedModel) {
      tokenCount = await getTokenCount(payload, selectedModel)
    } else {
      consola.warn("No model selected, skipping token count calculation")
    }
  } catch (error) {
    consola.warn("Failed to calculate token count:", error)
  }

  c.set("logInfo", buildLogInfo(payload, tokenCount))

  if (state.manualApprove) await awaitApproval()

  normalizeMaxTokens(payload, selectedModel)

  const response = await createChatCompletions(payload)

  // Streaming: response is a raw fetch Response — pipe body directly
  if (response instanceof Response) {
    const startTime = Date.now()
    let byteCount = 0
    let chunkCount = 0

    const monitor = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk: Uint8Array, controller) {
        chunkCount++
        byteCount += chunk.byteLength
        if (chunkCount === 1) {
          consola.info(`TTFT: ${Date.now() - startTime}ms`)
        }
        controller.enqueue(chunk)
      },
      flush() {
        consola.info(
          `Stream complete: ${chunkCount} chunks, ${byteCount} bytes in ${Date.now() - startTime}ms`,
        )
      },
    })

    const body = response.body
    if (!body) {
      return c.text("No response body", 502)
    }

    return new Response(body.pipeThrough(monitor), {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    })
  }

  // Non-streaming: response is a parsed JSON object
  consola.debug("Non-streaming response:", JSON.stringify(response))
  return c.json(response)
}
