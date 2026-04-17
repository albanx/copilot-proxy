import type { MiddlewareHandler } from "hono"

import consola from "consola"

export interface RequestLogInfo {
  model?: string
  sourceModel?: string
  upstream?: string
  stream?: boolean
  messages?: number
  tools?: number
  account?: string
  note?: string
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
    const start = Date.now()
    await next()
    const durationMs = Date.now() - start

    const info: RequestLogInfo = c.get("logInfo") ?? {}
    const parts: Array<string> = []

    if (info.model) {
      const from =
        info.sourceModel && info.sourceModel !== info.model ?
          `(from=${info.sourceModel})`
        : ""
      parts.push(`model=${info.model}${from}`)
    }
    if (info.stream !== undefined) parts.push(`stream=${info.stream}`)
    if (info.messages !== undefined) parts.push(`messages=${info.messages}`)
    if (info.tools !== undefined) parts.push(`tools=${info.tools}`)
    if (info.upstream) parts.push(`upstream=${info.upstream}`)
    if (info.account) parts.push(`account=${info.account}`)
    if (info.note) parts.push(`note="${info.note}"`)

    const url = new URL(c.req.url)
    const path = `${url.pathname}${url.search}`
    const extras = parts.length > 0 ? ` ${parts.join(" ")}` : ""

    consola.info(
      `${c.req.method} ${path} ${colorStatus(c.res.status)} ${durationMs}ms${extras}`,
    )
  }
}
