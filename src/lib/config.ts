// Behavioral stub of the upstream fs-backed config module. This proxy has no
// per-model settings file, so each function returns a safe default that keeps
// the Responses API routing path faithful to upstream behavior:
//   - context management ON (upstream default)
//   - WebSocket transport OFF (no WS infrastructure here -> HTTP-only routing)
//   - no per-model compaction override (falls back to ratio-based threshold)
//   - no extra system prompt injection
//   - "xhigh" reasoning effort for gpt-5.3+, "high" otherwise (upstream default)

export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"

const GPT_MODEL_PATTERN = /^gpt-(\d+)(?:\.(\d+))?/

const isGptVersionAtLeast = (
  model: string,
  minimumMajor: number,
  minimumMinor: number,
): boolean => {
  const match = GPT_MODEL_PATTERN.exec(model)
  if (!match) {
    return false
  }
  const majorVersion = Number.parseInt(match[1], 10)
  if (majorVersion > minimumMajor) {
    return true
  }
  if (majorVersion !== minimumMajor) {
    return false
  }
  const minorVersion = match[2] ? Number.parseInt(match[2], 10) : 0
  return minorVersion >= minimumMinor
}

export const isGpt53OrAbove = (model: string): boolean =>
  isGptVersionAtLeast(model, 5, 3)

export const isGpt56OrAbove = (model: string): boolean =>
  isGptVersionAtLeast(model, 5, 6)

export const isResponsesApiContextManagementEnabled = (): boolean => true

export const isResponsesApiWebSocketEnabled = (): boolean => false

export const getModelResponsesApiCompactThreshold = (
  _model: string,
): number | undefined => undefined

export const getExtraPromptForModel = (_model: string): string => ""

export const getReasoningEffortForModel = (model: string): ReasoningEffort =>
  isGpt53OrAbove(model) ? "xhigh" : "high"
