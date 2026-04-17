import { Hono } from "hono"

import { copilotBaseUrl } from "~/lib/api-config"
import { forwardError } from "~/lib/error"
import { state } from "~/lib/state"
import {
  createEmbeddings,
  type EmbeddingRequest,
} from "~/services/copilot/create-embeddings"

export const embeddingRoutes = new Hono()

embeddingRoutes.post("/", async (c) => {
  try {
    const payload = await c.req.json<EmbeddingRequest>()

    const inputCount = Array.isArray(payload.input) ? payload.input.length : 1
    c.set("logInfo", {
      model: payload.model,
      upstream: `${copilotBaseUrl(state)}/embeddings`,
      messages: inputCount,
      account: state.accountType,
    })

    const response = await createEmbeddings(payload)

    return c.json(response)
  } catch (error) {
    return await forwardError(c, error)
  }
})
