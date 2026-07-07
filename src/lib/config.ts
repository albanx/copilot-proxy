// Behavioral stub of the upstream fs-backed config module. This proxy has no
// per-model settings file, so each function returns a safe default that keeps
// the Responses API routing path faithful to upstream behavior:
//   - context management ON (upstream default)
//   - WebSocket transport OFF (no WS infrastructure here -> HTTP-only routing)
//   - no per-model compaction override (falls back to ratio-based threshold)
//   - no extra system prompt injection
//   - "high" reasoning effort (upstream default for non-gpt5.3+ models)

export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"

export const isResponsesApiContextManagementEnabled = (): boolean => true

export const isResponsesApiWebSocketEnabled = (): boolean => false

export const getModelResponsesApiCompactThreshold = (
  _model: string,
): number | undefined => undefined

export const getExtraPromptForModel = (_model: string): string => ""

export const getReasoningEffortForModel = (
  _model: string,
): ReasoningEffort => "high"
