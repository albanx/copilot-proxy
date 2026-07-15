import type { Context, MiddlewareHandler } from "hono"

import consola from "consola"

export interface RequestLogInfo {
  model?: string
  sourceModel?: string
  upstream?: string
  stream?: boolean
  messages?: number
  tools?: number
  responseFormat?: string
  account?: string
  inputTokens?: number
  outputTokens?: number
  // Prompt-cache token counts reported by upstream (read = cache hits,
  // write = tokens newly written to the cache).
  cacheReadTokens?: number
  cacheWriteTokens?: number
  stopReason?: string
  note?: string
  // Reasoning / thinking parameters actually applied for this request.
  reasoningEffort?: string
  thinkingBudget?: number
  contextWindow?: number
}

declare module "hono" {
  interface ContextVariableMap {
    logInfo?: RequestLogInfo
  }
}

const colorStatus = (status: number): string => {
  if (status >= 500) return `\u001B[31m${status}\u001B[0m`
  if (status >= 400) return `\u001B[33m${status}\u001B[0m`
  if (status >= 300) return `\u001B[36m${status}\u001B[0m`
  return `\u001B[32m${status}\u001B[0m`
}

const PROMPT_PREVIEW_MAX = 80

/** Join the text blocks of a message's content into a single string. */
const contentToText = (content: unknown): string | undefined => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return undefined

  const parts: Array<string> = []
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue
    const record = block as Record<string, unknown>
    // "text" (Anthropic / OpenAI chat) and "input_text" (OpenAI Responses).
    if (
      (record.type === "text" || record.type === "input_text")
      && typeof record.text === "string"
    ) {
      parts.push(record.text)
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined
}

/**
 * Find the latest user-authored text in a request body, across the payload
 * shapes this proxy accepts: Anthropic `/v1/messages` and OpenAI
 * `/chat/completions` (`messages[]`), and OpenAI `/responses` (`input`, which
 * may be a bare string). Scans from the end so multi-turn/agentic requests show
 * the most recent prompt; skips tool-result-only turns (no text) and falls back
 * to the previous user turn.
 */
const latestUserText = (body: unknown): string | undefined => {
  if (typeof body !== "object" || body === null) return undefined
  const record = body as Record<string, unknown>

  if (typeof record.input === "string") return record.input

  const items =
    Array.isArray(record.messages) ? record.messages
    : Array.isArray(record.input) ? record.input
    : undefined
  if (!items) return undefined

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (typeof item !== "object" || item === null) continue
    const message = item as Record<string, unknown>
    if (message.role !== "user") continue
    const text = contentToText(message.content)
    if (text) return text
  }
  return undefined
}

/**
 * Build a short, single-line preview of the user's prompt for the entry log
 * line. Collapses whitespace and strips control characters (so a stray ANSI
 * escape in user text can't bleed into the terminal), then truncates to
 * PROMPT_PREVIEW_MAX. Returns undefined when there is no extractable prompt.
 * Exported for unit testing.
 */
export const buildPromptPreview = (body: unknown): string | undefined => {
  const text = latestUserText(body)
  if (!text) return undefined

  const oneLine = text
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
  if (oneLine.length === 0) return undefined

  return oneLine.length > PROMPT_PREVIEW_MAX ?
      `${oneLine.slice(0, PROMPT_PREVIEW_MAX)}…`
    : oneLine
}

/**
 * Read the prompt preview from a request without disturbing the handler: Hono
 * caches the request body, so a later `c.req.json()` in the handler still works.
 * Only peeks at JSON POST bodies; never throws.
 */
const readPromptPreview = async (c: Context): Promise<string | undefined> => {
  if (c.req.method !== "POST") return undefined
  if (!(c.req.header("content-type") ?? "").includes("application/json")) {
    return undefined
  }

  try {
    return buildPromptPreview(await c.req.json())
  } catch {
    return undefined
  }
}

export const requestLogger = (): MiddlewareHandler => {
  return async (c, next) => {
    const DIM = "\u001B[2m"
    const CYAN = "\u001B[36m"
    const BOLD = "\u001B[1m"
    const RESET = "\u001B[0m"

    const url = new URL(c.req.url)
    const path = `${url.pathname}${url.search}`

    const promptPreview = await readPromptPreview(c)
    const previewStr =
      promptPreview ? `  ${DIM}"${promptPreview}"${RESET}` : ""
    consola.info(`${DIM}-->${RESET} ${c.req.method} ${path}${previewStr}`)

    const start = Date.now()
    await next()
    const durationMs = Date.now() - start

    const info: RequestLogInfo = c.get("logInfo") ?? {}

    const params: Array<string> = []
    if (info.model) {
      const from =
        info.sourceModel && info.sourceModel !== info.model ?
          `${DIM}(${info.sourceModel})${RESET}`
        : ""
      params.push(`${BOLD}model${RESET}=${info.model}${from}`)
    }
    if (info.messages !== undefined) params.push(`msgs=${info.messages}`)
    if (info.stream !== undefined) params.push(`stream=${info.stream}`)
    if (info.responseFormat) params.push(`format=${info.responseFormat}`)
    if (info.tools) params.push(`tools=${info.tools}`)
    if (info.reasoningEffort)
      params.push(`${BOLD}effort${RESET}=${info.reasoningEffort}`)
    if (info.thinkingBudget !== undefined)
      params.push(`${BOLD}thinking${RESET}=${info.thinkingBudget}`)
    if (info.contextWindow !== undefined)
      params.push(`ctx=${info.contextWindow}`)
    if (info.inputTokens !== undefined)
      params.push(`tokens=${info.inputTokens}/${info.outputTokens ?? 0}`)
    if (info.cacheReadTokens !== undefined || info.cacheWriteTokens !== undefined)
      params.push(
        `cache=${info.cacheReadTokens ?? 0}r/${info.cacheWriteTokens ?? 0}w`,
      )
    if (info.stopReason) params.push(`stop=${info.stopReason}`)
    if (info.note) params.push(`note="${info.note}"`)

    const duration = `${DIM}${durationMs}ms${RESET}`
    const upstream =
      info.upstream ? ` ${DIM}→${RESET} ${CYAN}${info.upstream}${RESET}` : ""
    const paramsStr =
      params.length > 0 ? `  ${DIM}|${RESET}  ${params.join("  ")}` : ""

    consola.info(
      `${DIM}<--${RESET} ${c.req.method} ${path} ${colorStatus(c.res.status)} ${duration}${upstream}${paramsStr}`,
    )
  }
}
