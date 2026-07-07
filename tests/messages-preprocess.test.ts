import { describe, expect, test } from "bun:test"

import { prepareMessagesApiPayload } from "../src/routes/messages/preprocess"
import { type AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types"
import { type Model } from "../src/services/copilot/get-models"

/**
 * Build a minimal chat Model, overriding only the capability fields the
 * preprocessor reads (`capabilities.supports`).
 */
function mkModel(supports: Model["capabilities"]["supports"]): Model {
  return {
    capabilities: {
      family: "test",
      object: "model_capabilities",
      tokenizer: "o200k_base",
      type: "chat",
      supports,
    },
    id: "test-model",
    model_picker_enabled: true,
    name: "Test Model",
    object: "model",
    preview: false,
    vendor: "test",
    version: "1.0",
  }
}

/** Minimal Anthropic payload with room for the fields under test. */
function mkPayload(
  overrides: Partial<AnthropicMessagesPayload> & { model: string },
): AnthropicMessagesPayload {
  return {
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  }
}

describe("prepareMessagesApiPayload — non-adaptive models", () => {
  test("strips output_config.effort when the model has no reasoning_effort list (haiku-4.5 400 repro)", () => {
    const payload = mkPayload({
      model: "claude-haiku-4.5",
      output_config: { effort: "high" },
    })
    prepareMessagesApiPayload(payload, mkModel({}))

    // output_config becomes empty after removing effort, so it is deleted.
    expect(payload.output_config).toBeUndefined()
  })

  test("removes only effort, preserving other output_config keys", () => {
    const payload = mkPayload({
      model: "claude-haiku-4.5",
      output_config: { effort: "high", verbosity: "low" },
    })
    prepareMessagesApiPayload(payload, mkModel({}))

    expect(payload.output_config).toEqual({ verbosity: "low" })
  })

  test("keeps output_config.effort when the model advertises a reasoning_effort list", () => {
    const payload = mkPayload({
      model: "some-reasoner",
      output_config: { effort: "high" },
    })
    prepareMessagesApiPayload(
      payload,
      mkModel({ reasoning_effort: ["low", "medium", "high"] }),
    )

    // Non-adaptive + a reasoning_effort list: effort is left untouched.
    expect(payload.output_config).toEqual({ effort: "high" })
  })

  test("converts adaptive thinking to enabled with budget = (max_thinking_budget ?? 4096) - 1", () => {
    const payload = mkPayload({
      model: "claude-haiku-4.5",
      thinking: { type: "adaptive" },
    })
    prepareMessagesApiPayload(payload, mkModel({ max_thinking_budget: 8000 }))

    expect(payload.thinking).toEqual({ type: "enabled", budget_tokens: 7999 })
  })

  test("defaults the converted budget to 4095 when max_thinking_budget is absent", () => {
    const payload = mkPayload({
      model: "claude-haiku-4.5",
      thinking: { type: "adaptive" },
    })
    prepareMessagesApiPayload(payload, mkModel({}))

    expect(payload.thinking).toEqual({ type: "enabled", budget_tokens: 4095 })
  })

  test("deletes thinking when tool_choice forces tool use (type: any)", () => {
    const payload = mkPayload({
      model: "claude-haiku-4.5",
      thinking: { type: "enabled", budget_tokens: 1024 },
      tool_choice: { type: "any" },
    })
    prepareMessagesApiPayload(payload, mkModel({}))

    expect(payload.thinking).toBeUndefined()
  })
})

describe("prepareMessagesApiPayload — adaptive models", () => {
  test("rewrites enabled thinking to adaptive and sets output_config.effort (enabled 400 repro)", () => {
    const payload = mkPayload({
      model: "claude-sonnet-4.5",
      thinking: { type: "enabled", budget_tokens: 1024 },
      output_config: { effort: "high" },
    })
    prepareMessagesApiPayload(
      payload,
      mkModel({
        adaptive_thinking: true,
        reasoning_effort: ["low", "medium", "high"],
      }),
    )

    expect(payload.thinking?.type).toBe("adaptive")
    expect(payload.output_config).toEqual({ effort: "high" })
  })

  test("normalizes none/minimal effort to low", () => {
    const payload = mkPayload({
      model: "claude-sonnet-4.5",
      output_config: { effort: "minimal" },
    })
    prepareMessagesApiPayload(
      payload,
      mkModel({
        adaptive_thinking: true,
        reasoning_effort: ["low", "medium", "high"],
      }),
    )

    expect(payload.output_config).toEqual({ effort: "low" })
  })

  test("snaps an unsupported effort to the last advertised level", () => {
    const payload = mkPayload({
      model: "claude-sonnet-4.5",
      output_config: { effort: "high" },
    })
    prepareMessagesApiPayload(
      payload,
      mkModel({ adaptive_thinking: true, reasoning_effort: ["low", "medium"] }),
    )

    expect(payload.output_config).toEqual({ effort: "medium" })
  })

  test("falls back to the per-model default effort when the payload omits output_config", () => {
    const payload = mkPayload({ model: "claude-sonnet-4.5" })
    prepareMessagesApiPayload(
      payload,
      mkModel({
        adaptive_thinking: true,
        reasoning_effort: ["low", "medium", "high"],
      }),
    )

    // getReasoningEffortForModel stub returns "high".
    expect(payload.output_config).toEqual({ effort: "high" })
  })

  test("forces thinking.display=summarized for models at version >= 4.7", () => {
    const payload = mkPayload({
      model: "claude-opus-4.8",
      thinking: { type: "enabled", budget_tokens: 1024 },
    })
    prepareMessagesApiPayload(
      payload,
      mkModel({ adaptive_thinking: true, reasoning_effort: ["high"] }),
    )

    expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" })
  })

  test("does not force display for a versioned model < 4.7 that already had thinking", () => {
    const payload = mkPayload({
      model: "claude-sonnet-4.5",
      thinking: { type: "enabled", budget_tokens: 1024 },
    })
    prepareMessagesApiPayload(
      payload,
      mkModel({ adaptive_thinking: true, reasoning_effort: ["high"] }),
    )

    expect(payload.thinking).toEqual({ type: "adaptive" })
  })

  test("defaults display=summarized when the request had no prior thinking", () => {
    const payload = mkPayload({ model: "claude-sonnet-4.5" })
    prepareMessagesApiPayload(
      payload,
      mkModel({ adaptive_thinking: true, reasoning_effort: ["high"] }),
    )

    expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" })
  })

  test("leaves the payload untouched when an adaptive model is forced to use tools", () => {
    const payload = mkPayload({
      model: "claude-sonnet-4.5",
      thinking: { type: "enabled", budget_tokens: 1024 },
      tool_choice: { type: "tool", name: "search" },
    })
    prepareMessagesApiPayload(
      payload,
      mkModel({ adaptive_thinking: true, reasoning_effort: ["high"] }),
    )

    // disableThink short-circuits the adaptive branch; the non-adaptive branch
    // is skipped because the model IS adaptive — so nothing changes.
    expect(payload.thinking).toEqual({ type: "enabled", budget_tokens: 1024 })
  })
})

describe("prepareMessagesApiPayload — no selected model", () => {
  test("is a safe no-op on the reasoning fields when the model is unknown", () => {
    const payload = mkPayload({
      model: "mystery",
      thinking: { type: "enabled", budget_tokens: 1024 },
      output_config: { effort: "high" },
    })
    prepareMessagesApiPayload(payload, undefined)

    // Undefined model → non-adaptive branch with no supports: strips effort
    // (no reasoning_effort list) but leaves thinking as-is (not adaptive-typed).
    expect(payload.output_config).toBeUndefined()
    expect(payload.thinking).toEqual({ type: "enabled", budget_tokens: 1024 })
  })
})
