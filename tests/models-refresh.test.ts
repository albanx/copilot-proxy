import { afterEach, describe, expect, test } from "bun:test"

import { state } from "../src/lib/state"
import { refreshModels, stopModelsRefreshLoop } from "../src/lib/utils"
import {
  type Model,
  type ModelsResponse,
} from "../src/services/copilot/get-models"

/** Build a minimal Copilot model, overriding only the fields under test. */
function mkModel(overrides: Partial<Model> & { id: string }): Model {
  return {
    capabilities: {
      family: "gpt",
      object: "model_capabilities",
      tokenizer: "o200k_base",
      type: "chat",
    },
    model_picker_enabled: true,
    name: overrides.id,
    object: "model",
    preview: false,
    vendor: "openai",
    version: "1",
    ...overrides,
  }
}

/** Wrap models in the upstream `/models` response envelope. */
function mkResponse(data: Array<Model>): ModelsResponse {
  return { data, object: "list" }
}

/** Build a fake fetcher that resolves to the given response. */
function mkFetcher(response: ModelsResponse): () => Promise<ModelsResponse> {
  return () => Promise.resolve(response)
}

/**
 * Read `state.models` through a function boundary. `refreshModels` mutates the
 * imported `state.models`, which TS's flow analysis can't see — reading via a
 * typed return defeats the sticky narrowing from `state.models = undefined`.
 */
function readModels(): ModelsResponse | undefined {
  return state.models
}

const originalModels = state.models

afterEach(() => {
  // Restore shared state and clear any pending timer between tests.
  state.models = originalModels
  stopModelsRefreshLoop()
})

describe("refreshModels", () => {
  test("stores the fetched models in state", async () => {
    state.models = undefined
    await refreshModels(mkFetcher(mkResponse([mkModel({ id: "gpt-5.5" })])))

    expect(readModels()?.data.map((m) => m.id)).toEqual(["gpt-5.5"])
  })

  test("keeps picker-enabled models and embeddings, drops the rest", async () => {
    state.models = undefined
    await refreshModels(
      mkFetcher(
        mkResponse([
          mkModel({ id: "picker-on", model_picker_enabled: true }),
          mkModel({
            id: "embed",
            model_picker_enabled: false,
            capabilities: {
              family: "embed",
              object: "model_capabilities",
              tokenizer: "cl100k_base",
              type: "embeddings",
            },
          }),
          mkModel({ id: "hidden-chat", model_picker_enabled: false }),
        ]),
      ),
    )

    expect(readModels()?.data.map((m) => m.id)).toEqual(["picker-on", "embed"])
  })

  test("preserves the response envelope fields other than data", async () => {
    state.models = undefined
    await refreshModels(mkFetcher({ data: [], object: "custom-list" }))

    expect(readModels()?.object).toBe("custom-list")
  })

  test("computes the newly-added set against the previous cache", async () => {
    state.models = mkResponse([mkModel({ id: "existing" })])
    await refreshModels(
      mkFetcher(
        mkResponse([mkModel({ id: "existing" }), mkModel({ id: "fresh" })]),
      ),
    )

    expect(readModels()?.data.map((m) => m.id)).toEqual(["existing", "fresh"])
  })

  test("propagates fetcher rejections so the caller can keep the old cache", async () => {
    const previous = mkResponse([mkModel({ id: "stable" })])
    state.models = previous

    const boom = (): Promise<ModelsResponse> =>
      Promise.reject(new Error("upstream down"))
    await expect(refreshModels(boom)).rejects.toThrow("upstream down")

    // On failure the previous cache is left untouched.
    expect(readModels()).toBe(previous)
  })
})

describe("stopModelsRefreshLoop", () => {
  test("is safe to call when no loop is active", () => {
    expect(() => {
      stopModelsRefreshLoop()
      stopModelsRefreshLoop()
    }).not.toThrow()
  })
})
