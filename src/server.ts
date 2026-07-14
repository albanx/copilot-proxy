import { Hono } from "hono"
import { cors } from "hono/cors"

import { requestLogger } from "./lib/request-logger"
import { completionRoutes } from "./routes/chat-completions/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { messageRoutes } from "./routes/messages/route"
import { modelRoutes } from "./routes/models/route"
import { responsesRoutes } from "./routes/responses/route"

export const server = new Hono()

/**
 * Origins allowed to call the proxy from a browser.
 *
 * The proxy exposes the user's Copilot subscription with no inbound
 * authentication, so a wildcard `Access-Control-Allow-Origin` would let any
 * website they happen to visit POST to `localhost:4141`, spend their quota and
 * read the model's replies (a JSON POST preflights, and a wildcard policy
 * approves it). Binding to loopback does not help — the browser runs on the
 * same machine.
 *
 * Non-browser clients (Claude Code, curl, the OpenAI/Anthropic SDKs) send no
 * `Origin` header and do not enforce CORS, so they are unaffected by this.
 */
const isAllowedOrigin = (origin: string): string | null => {
  let hostname: string
  try {
    hostname = new URL(origin).hostname
  } catch {
    return null
  }

  const isLoopback =
    hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "[::1]"
    || hostname === "::1"

  return isLoopback ? origin : null
}

server.use(requestLogger())
server.use(cors({ origin: isAllowedOrigin }))

server.get("/", (c) => c.text("Server running"))

server.route("/chat/completions", completionRoutes)
server.route("/models", modelRoutes)
server.route("/embeddings", embeddingRoutes)
server.route("/responses", responsesRoutes)

// Compatibility with tools that expect v1/ prefix
server.route("/v1/chat/completions", completionRoutes)
server.route("/v1/models", modelRoutes)
server.route("/v1/embeddings", embeddingRoutes)
server.route("/v1/responses", responsesRoutes)

// Anthropic compatible endpoints
server.route("/v1/messages", messageRoutes)
