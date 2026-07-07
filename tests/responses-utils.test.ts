import { describe, expect, test } from "bun:test"

import { COMPACT_REQUEST } from "../src/lib/compact"
import { type ResponsesPayload } from "../src/services/copilot/create-responses-types"
import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
  getResponsesTransportForModel,
  hasAgentInitiator,
  hasVisionInput,
  resolveResponsesCompactThreshold,
} from "../src/routes/responses/utils"

/** Build a minimal Responses payload, overriding only the fields under test. */
function mkPayload(overrides: Partial<ResponsesPayload>): ResponsesPayload {
  return {
    model: "gpt-5.5",
    ...overrides,
  }
}

describe("getResponsesTransportForModel", () => {
  test("returns http when the model advertises /responses", () => {
    expect(
      getResponsesTransportForModel({ supported_endpoints: ["/responses"] }),
    ).toBe("http")
  })

  test("returns null when the model does not advertise /responses", () => {
    expect(
      getResponsesTransportForModel({ supported_endpoints: ["/chat"] }),
    ).toBeNull()
  })

  test("returns null for an undefined model", () => {
    expect(getResponsesTransportForModel(undefined)).toBeNull()
  })

  test("falls back to http even when a ws endpoint is present (ws disabled)", () => {
    // The local config stub disables the WebSocket transport, so the ws:/responses
    // endpoint is ignored and the http endpoint wins.
    expect(
      getResponsesTransportForModel({
        supported_endpoints: ["ws:/responses", "/responses"],
      }),
    ).toBe("http")
  })

  test("still returns http for a COMPACT_REQUEST compaction call", () => {
    expect(
      getResponsesTransportForModel(
        { supported_endpoints: ["/responses"] },
        { compactType: COMPACT_REQUEST },
      ),
    ).toBe("http")
  })
})

describe("hasVisionInput", () => {
  test("detects an input_image content block nested in a message", () => {
    const payload = mkPayload({
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "look" },
            { type: "input_image", image_url: "data:...", detail: "auto" },
          ],
        },
      ],
    })
    expect(hasVisionInput(payload)).toBe(true)
  })

  test("returns false for text-only input", () => {
    const payload = mkPayload({
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      ],
    })
    expect(hasVisionInput(payload)).toBe(false)
  })
})

describe("hasAgentInitiator", () => {
  test("flags an assistant last message as an agent call", () => {
    const payload = mkPayload({
      input: [
        { type: "message", role: "user", content: "hi" },
        { type: "message", role: "assistant", content: "prefill" },
      ],
    })
    expect(hasAgentInitiator(payload)).toBe(true)
  })

  test("treats a user last message as a user call", () => {
    const payload = mkPayload({
      input: [
        { type: "message", role: "assistant", content: "earlier" },
        { type: "message", role: "user", content: "now" },
      ],
    })
    expect(hasAgentInitiator(payload)).toBe(false)
  })

  test("treats a last item without a role as an agent call", () => {
    const payload = mkPayload({
      input: [{ type: "function_call_output", call_id: "c1", output: "done" }],
    })
    expect(hasAgentInitiator(payload)).toBe(true)
  })

  test("returns false when there are no input items", () => {
    expect(hasAgentInitiator(mkPayload({ input: [] }))).toBe(false)
  })
})

describe("resolveResponsesCompactThreshold", () => {
  test("applies the 0.9 ratio to a positive max prompt token budget", () => {
    expect(resolveResponsesCompactThreshold(100_000)).toBe(90_000)
  })

  test("falls back to the 200k default when the budget is missing", () => {
    expect(resolveResponsesCompactThreshold(undefined)).toBe(180_000)
  })

  test("falls back to the default for a non-positive budget", () => {
    expect(resolveResponsesCompactThreshold(0)).toBe(180_000)
  })

  test("honors a custom ratio", () => {
    expect(resolveResponsesCompactThreshold(100_000, 0.5)).toBe(50_000)
  })
})

describe("applyResponsesApiContextManagement", () => {
  test("injects a compaction context_management entry when none is present", () => {
    const payload = mkPayload({ input: [] })
    applyResponsesApiContextManagement(payload, 100_000)
    expect(payload.context_management).toEqual([
      { type: "compaction", compact_threshold: 90_000 },
    ])
  })

  test("leaves an existing context_management untouched", () => {
    const payload = mkPayload({
      input: [],
      context_management: [{ type: "compaction", compact_threshold: 42 }],
    })
    applyResponsesApiContextManagement(payload, 100_000)
    expect(payload.context_management).toEqual([
      { type: "compaction", compact_threshold: 42 },
    ])
  })

  test("skips injection when the last item is a terminal compaction_trigger", () => {
    const payload = mkPayload({ input: [{ type: "compaction_trigger" }] })
    applyResponsesApiContextManagement(payload, 100_000)
    expect(payload.context_management).toBeUndefined()
  })

  test("uses the 200k default threshold when no budget is provided", () => {
    const payload = mkPayload({ input: [] })
    applyResponsesApiContextManagement(payload)
    expect(payload.context_management).toEqual([
      { type: "compaction", compact_threshold: 180_000 },
    ])
  })
})

describe("compactInputByLatestCompaction", () => {
  test("slices the input from the latest compaction item", () => {
    const payload = mkPayload({
      input: [
        { type: "message", role: "user", content: "old" },
        { type: "compaction", id: "cm1", encrypted_content: "ENC" },
        { type: "message", role: "assistant", content: "after" },
      ],
    })

    compactInputByLatestCompaction(payload)

    expect(payload.input).toEqual([
      { type: "compaction", id: "cm1", encrypted_content: "ENC" },
      { type: "message", role: "assistant", content: "after" },
    ])
  })

  test("keeps only the most recent compaction window", () => {
    const payload = mkPayload({
      input: [
        { type: "compaction", id: "cm1", encrypted_content: "A" },
        { type: "message", role: "user", content: "mid" },
        { type: "compaction", id: "cm2", encrypted_content: "B" },
        { type: "message", role: "assistant", content: "tail" },
      ],
    })

    compactInputByLatestCompaction(payload)

    expect(payload.input).toEqual([
      { type: "compaction", id: "cm2", encrypted_content: "B" },
      { type: "message", role: "assistant", content: "tail" },
    ])
  })

  test("is a no-op when there is no compaction item", () => {
    const payload = mkPayload({
      input: [{ type: "message", role: "user", content: "only" }],
    })

    compactInputByLatestCompaction(payload)

    expect(payload.input).toEqual([
      { type: "message", role: "user", content: "only" },
    ])
  })
})
