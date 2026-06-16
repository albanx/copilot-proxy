import type { MiddlewareHandler } from "hono"

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

export const requestLogger = (): MiddlewareHandler => {
  return async (c, next) => {
    const DIM = "\u001B[2m"
    const CYAN = "\u001B[36m"
    const BOLD = "\u001B[1m"
    const RESET = "\u001B[0m"

    const url = new URL(c.req.url)
    const path = `${url.pathname}${url.search}`

    consola.info(`${DIM}-->${RESET} ${c.req.method} ${path}`)

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
