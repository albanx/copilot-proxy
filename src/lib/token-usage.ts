// Minimal stub of the upstream token-usage subsystem. This proxy does not
// persist billing/token usage, so the recorder is a no-op. Only the pure
// usage-normalization helpers and the types consumed by the Responses API flow
// are provided here (no store, pricing, or event bus).

export interface UsageTokens {
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  input_tokens?: number
  output_tokens?: number
  total_nano_aiu?: number
  total_tokens?: number
}

export type TokenUsageEndpoint =
  | "messages"
  | "responses"
  | "chat/completions"
  | "count_tokens"

interface CopilotTokenUsageRecorderOptions {
  endpoint: TokenUsageEndpoint
  model: string
  fallbackSessionId?: string | null
  sessionId?: string | null
  traceId?: string | null
  pricing?: unknown
  pricingCurrency?: string | null
}

export const normalizeToken = (value: number | null | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0
  }
  return Math.floor(value)
}

export const normalizeOptionalToken = (
  value: number | null | undefined,
): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined
  }
  return Math.floor(value)
}

export const normalizeResponsesUsage = (
  usage:
    | {
        input_tokens?: number
        input_tokens_details?: {
          cached_tokens?: number
        }
        output_tokens?: number
        total_tokens?: number
      }
    | null
    | undefined,
): UsageTokens => {
  const cachedTokens = normalizeToken(
    usage?.input_tokens_details?.cached_tokens,
  )
  const inputTokens = normalizeToken(usage?.input_tokens)
  return {
    cache_read_input_tokens: cachedTokens,
    input_tokens: Math.max(0, inputTokens - cachedTokens),
    output_tokens: normalizeToken(usage?.output_tokens),
    total_tokens: normalizeOptionalToken(usage?.total_tokens),
  }
}

export const createCopilotTokenUsageRecorder = (
  _options: CopilotTokenUsageRecorderOptions,
): ((usage: UsageTokens) => void) => {
  return () => {
    // No-op: billing/token persistence is intentionally not implemented here.
  }
}
