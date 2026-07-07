import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export const getModels = async () => {
  const response = await fetch(`${copilotBaseUrl(state)}/models`, {
    headers: copilotHeaders(state),
  })

  if (!response.ok) throw new HTTPError("Failed to get models", response)

  return (await response.json()) as ModelsResponse
}

export interface ModelsResponse {
  data: Array<Model>
  object: string
}

interface ModelVisionLimits {
  max_prompt_images?: number
  max_prompt_image_size?: number
  supported_media_types?: Array<string>
}

interface ModelLimits {
  max_context_window_tokens?: number
  max_output_tokens?: number
  max_prompt_tokens?: number
  max_inputs?: number
  vision?: ModelVisionLimits
}

interface ModelSupports {
  tool_calls?: boolean
  parallel_tool_calls?: boolean
  dimensions?: boolean
  streaming?: boolean
  vision?: boolean
  prediction?: boolean
  structured_outputs?: boolean
  /**
   * Upstream does NOT expose a plain `thinking` boolean. Thinking support is
   * signaled by `adaptive_thinking` and/or a [min, max] thinking-budget window.
   */
  adaptive_thinking?: boolean
  /** Maximum thinking budget in tokens (when thinking is supported). */
  max_thinking_budget?: number
  /** Minimum thinking budget in tokens (when thinking is supported). */
  min_thinking_budget?: number
  /**
   * The reasoning effort levels the model accepts, e.g. ["low","medium","high"].
   * When present and non-empty, the model accepts a reasoning_effort parameter.
   */
  reasoning_effort?: Array<string>
}

interface ModelCapabilities {
  family: string
  // Embedding models (and some others) omit `limits`/`supports`, so these are
  // optional at runtime even though chat models always include them.
  limits?: ModelLimits
  object: string
  supports?: ModelSupports
  tokenizer: string
  type: string
}

export interface Model {
  capabilities: ModelCapabilities
  id: string
  model_picker_enabled: boolean
  name: string
  object: string
  preview: boolean
  vendor: string
  version: string
  policy?: {
    state: string
    terms: string
  }
  /**
   * Upstream endpoints the model can be called on, e.g.
   * ["/chat/completions", "/responses", "/v1/messages"]. When present and it
   * includes "/v1/messages", the model accepts native Anthropic Messages
   * requests (which support assistant-message prefill) and can be routed to the
   * `/v1/messages` passthrough instead of being translated to
   * `/chat/completions`. Not all upstream deployments advertise this field, so
   * routing also falls back to a vendor/id heuristic.
   */
  supported_endpoints?: Array<string>
}
