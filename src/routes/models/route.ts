import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { state } from "~/lib/state"
import { cacheModels } from "~/lib/utils"

export const modelRoutes = new Hono()

modelRoutes.get("/", async (c) => {
  try {
    if (!state.models) {
      // This should be handled by startup logic, but as a fallback.
      await cacheModels()
    }

    const models = state.models?.data.map((model) => {
      // Embedding models (and some others) may omit `limits`/`supports`
      // entirely, so default them to empty objects before reading fields.
      const limits = model.capabilities.limits ?? {}
      const supports = model.capabilities.supports ?? {}

      return {
        id: model.id,
        object: "model",
        type: "model",
        created: 0, // No date available from source
        created_at: new Date(0).toISOString(), // No date available from source
        owned_by: model.vendor,
        display_name: model.name,
        // Context window / token limits (e.g. 1_000_000 for a 1M-context model)
        context_window: limits.max_context_window_tokens,
        max_input_tokens: limits.max_prompt_tokens,
        max_output_tokens: limits.max_output_tokens,
        // Capability flags so clients know which params the model accepts
        capabilities: {
          family: model.capabilities.family,
          tokenizer: model.capabilities.tokenizer,
          vision: supports.vision ?? false,
          tool_calls: supports.tool_calls ?? false,
          parallel_tool_calls: supports.parallel_tool_calls ?? false,
          streaming: supports.streaming ?? false,
          // Reasoning / thinking support. Upstream does not expose a `thinking`
          // boolean — derive it from adaptive_thinking or a budget window.
          thinking: Boolean(
            supports.adaptive_thinking
              || supports.max_thinking_budget
              || supports.min_thinking_budget,
          ),
          adaptive_thinking: supports.adaptive_thinking ?? false,
          max_thinking_budget: supports.max_thinking_budget,
          min_thinking_budget: supports.min_thinking_budget,
          // Effort levels the model accepts (empty/undefined => effort unsupported)
          reasoning_effort: supports.reasoning_effort ?? [],
        },
      }
    })

    return c.json({
      object: "list",
      data: models,
      has_more: false,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})
