import { describe, expect, test } from "bun:test"

import { type AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types"
import {
  decodeCompactionCarrierSignature,
  encodeCompactionCarrierSignature,
  resolveToolUseName,
  translateAnthropicMessagesToResponsesPayload,
  translateResponsesResultToAnthropic,
} from "../src/routes/messages/responses-translation"
import { type ResponsesResult } from "../src/services/copilot/create-responses-types"

/** Build a minimal Anthropic payload, overriding only the fields under test. */
function mkPayload(
  overrides: Partial<AnthropicMessagesPayload>,
): AnthropicMessagesPayload {
  return {
    model: "gpt-5.5",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  }
}

/** Build a minimal Responses result, overriding only the fields under test. */
function mkResult(overrides: Partial<ResponsesResult>): ResponsesResult {
  return {
    id: "resp_1",
    object: "response",
    created_at: 0,
    model: "gpt-5.5",
    output: [],
    output_text: "",
    status: "completed",
    usage: null,
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: 1,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    ...overrides,
  }
}

describe("translateAnthropicMessagesToResponsesPayload", () => {
  test("maps the fixed Responses request envelope", () => {
    const out = translateAnthropicMessagesToResponsesPayload(mkPayload({}))

    expect(out.model).toBe("gpt-5.5")
    expect(out.temperature).toBe(1)
    expect(out.top_p).toBeNull()
    expect(out.store).toBe(false)
    expect(out.parallel_tool_calls).toBe(true)
    expect(out.stream).toBeNull()
    expect(out.tools).toBeNull()
    expect(out.tool_choice).toBe("auto")
    expect(out.metadata).toBeNull()
    expect(out.instructions).toBeNull()
    expect(out.reasoning).toEqual({ effort: "high", summary: "detailed" })
    expect(out.include).toEqual(["reasoning.encrypted_content"])
  })

  test("clamps max_output_tokens up to the 12800 floor", () => {
    const out = translateAnthropicMessagesToResponsesPayload(
      mkPayload({ max_tokens: 1024 }),
    )
    expect(out.max_output_tokens).toBe(12800)
  })

  test("preserves max_output_tokens above the floor", () => {
    const out = translateAnthropicMessagesToResponsesPayload(
      mkPayload({ max_tokens: 32000 }),
    )
    expect(out.max_output_tokens).toBe(32000)
  })

  test("passes through top_p and stream when present", () => {
    const out = translateAnthropicMessagesToResponsesPayload(
      mkPayload({ top_p: 0.5, stream: true }),
    )
    expect(out.top_p).toBe(0.5)
    expect(out.stream).toBe(true)
  })

  test("translates a user string message into a Responses message item", () => {
    const out = translateAnthropicMessagesToResponsesPayload(mkPayload({}))
    expect(out.input).toEqual([
      { type: "message", role: "user", content: "hello" },
    ])
  })

  test("carries a string system prompt into instructions", () => {
    const out = translateAnthropicMessagesToResponsesPayload(
      mkPayload({ system: "be nice" }),
    )
    expect(out.instructions).toBe("be nice")
  })

  test("omits prompt_cache_key when there are no tools", () => {
    const out = translateAnthropicMessagesToResponsesPayload(mkPayload({}))
    expect("prompt_cache_key" in out).toBe(false)
  })

  test("emits prompt_cache_key and converts function tools when tools are present", () => {
    const out = translateAnthropicMessagesToResponsesPayload(
      mkPayload({
        tools: [
          {
            name: "get_weather",
            description: "d",
            input_schema: { type: "object", properties: {} },
          },
        ],
      }),
    )

    expect("prompt_cache_key" in out).toBe(true)
    // No metadata user_id and no request-context session affinity → null key.
    expect(out.prompt_cache_key).toBeNull()
    expect(out.tools).toEqual([
      {
        type: "function",
        name: "get_weather",
        parameters: { type: "object", properties: {} },
        strict: false,
        description: "d",
      },
    ])
  })
})

describe("compaction carrier signature", () => {
  test("encodes to cm1#<encrypted>@<id>", () => {
    expect(
      encodeCompactionCarrierSignature({
        id: "rs_1",
        encrypted_content: "ENC",
      }),
    ).toBe("cm1#ENC@rs_1")
  })

  test("round-trips through decode", () => {
    const signature = encodeCompactionCarrierSignature({
      id: "rs_9",
      encrypted_content: "abc123",
    })
    expect(decodeCompactionCarrierSignature(signature)).toEqual({
      id: "rs_9",
      encrypted_content: "abc123",
    })
  })

  test("returns undefined for a signature without the cm1# prefix", () => {
    expect(decodeCompactionCarrierSignature("ENC@rs_1")).toBeUndefined()
  })

  test("returns undefined when the id segment is empty", () => {
    expect(decodeCompactionCarrierSignature("cm1#ENC@")).toBeUndefined()
  })

  test("returns undefined when the encrypted segment is empty", () => {
    expect(decodeCompactionCarrierSignature("cm1#@rs_1")).toBeUndefined()
  })
})

describe("resolveToolUseName", () => {
  test("prefers a non-empty namespace", () => {
    expect(resolveToolUseName({ name: "f", namespace: "ns__f" })).toBe("ns__f")
  })

  test("falls back to name when namespace is missing", () => {
    expect(resolveToolUseName({ name: "f" })).toBe("f")
  })

  test("falls back to name when namespace is null or empty", () => {
    expect(resolveToolUseName({ name: "f", namespace: null })).toBe("f")
    expect(resolveToolUseName({ name: "f", namespace: "" })).toBe("f")
  })
})

describe("translateResponsesResultToAnthropic", () => {
  test("maps a text message and end_turn stop reason", () => {
    const out = translateResponsesResultToAnthropic(
      mkResult({
        output: [
          {
            id: "m1",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Hi there", annotations: [] }],
          },
        ],
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      }),
    )

    expect(out.role).toBe("assistant")
    expect(out.content).toEqual([{ type: "text", text: "Hi there" }])
    expect(out.stop_reason).toBe("end_turn")
    expect(out.usage).toEqual({ input_tokens: 100, output_tokens: 20 })
  })

  test("subtracts cached tokens and surfaces cache_read_input_tokens", () => {
    const out = translateResponsesResultToAnthropic(
      mkResult({
        output: [
          {
            id: "m1",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Hi", annotations: [] }],
          },
        ],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
          input_tokens_details: { cached_tokens: 30 },
        },
      }),
    )

    expect(out.usage).toEqual({
      input_tokens: 70,
      output_tokens: 20,
      cache_read_input_tokens: 30,
    })
  })

  test("maps a function call to a tool_use block with tool_use stop reason", () => {
    const out = translateResponsesResultToAnthropic(
      mkResult({
        output: [
          {
            type: "function_call",
            call_id: "call_1",
            name: "get_weather",
            arguments: '{"city":"Paris"}',
            status: "completed",
          },
        ],
      }),
    )

    expect(out.content).toEqual([
      {
        type: "tool_use",
        id: "call_1",
        name: "get_weather",
        input: { city: "Paris" },
      },
    ])
    expect(out.stop_reason).toBe("tool_use")
  })

  test("maps a reasoning item to a signed thinking block", () => {
    const out = translateResponsesResultToAnthropic(
      mkResult({
        output: [
          {
            id: "rs_1",
            type: "reasoning",
            summary: [{ type: "summary_text", text: "Let me think" }],
            encrypted_content: "ENC",
          },
          {
            id: "m1",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Answer", annotations: [] }],
          },
        ],
      }),
    )

    expect(out.content[0]).toEqual({
      type: "thinking",
      thinking: "Let me think",
      signature: "ENC@rs_1",
    })
    expect(out.content[1]).toEqual({ type: "text", text: "Answer" })
  })

  test("substitutes default thinking text for an empty reasoning summary", () => {
    const out = translateResponsesResultToAnthropic(
      mkResult({
        output: [
          {
            id: "rs_1",
            type: "reasoning",
            summary: [],
            encrypted_content: "ENC",
          },
        ],
      }),
    )

    expect(out.content[0]).toEqual({
      type: "thinking",
      thinking: "Thinking...",
      signature: "ENC@rs_1",
    })
  })

  test("maps an incomplete max_output_tokens result to max_tokens", () => {
    const out = translateResponsesResultToAnthropic(
      mkResult({
        status: "incomplete",
        output: [],
        incomplete_details: { reason: "max_output_tokens" },
      }),
    )
    expect(out.stop_reason).toBe("max_tokens")
  })

  test("falls back to output_text when there are no output items", () => {
    const out = translateResponsesResultToAnthropic(
      mkResult({ output: [], output_text: "fallback text" }),
    )
    expect(out.content).toEqual([{ type: "text", text: "fallback text" }])
    expect(out.stop_reason).toBe("end_turn")
  })
})
