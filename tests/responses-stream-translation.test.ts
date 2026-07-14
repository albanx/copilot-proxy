import { describe, expect, test } from "bun:test"

import { BRIDGE_TOOL_SEARCH_NAME } from "../src/lib/tool-search"
import { type AnthropicStreamEventData } from "../src/routes/messages/anthropic-types"
import {
  buildErrorEvent,
  createResponsesStreamState,
  translateResponsesStreamEvent,
} from "../src/routes/messages/responses-stream-translation"
import {
  type ResponsesResult,
  type ResponseStreamEvent,
} from "../src/services/copilot/create-responses-types"

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

describe("createResponsesStreamState", () => {
  test("defaults the tool search name to the bridge sentinel", () => {
    const state = createResponsesStreamState()
    expect(state.toolSearchName).toBe(BRIDGE_TOOL_SEARCH_NAME)
    expect(state.messageStartSent).toBe(false)
    expect(state.messageCompleted).toBe(false)
    expect(state.nextContentBlockIndex).toBe(0)
    expect(state.hasToolCall).toBe(false)
  })

  test("honors an explicit tool search name override", () => {
    const state = createResponsesStreamState({ toolSearchName: "ns__search" })
    expect(state.toolSearchName).toBe("ns__search")
  })
})

describe("translateResponsesStreamEvent", () => {
  test("emits message_start from response.created with derived usage", () => {
    const state = createResponsesStreamState()
    const event: ResponseStreamEvent = {
      type: "response.created",
      sequence_number: 0,
      response: mkResult({
        usage: { input_tokens: 100, output_tokens: 0, total_tokens: 100 },
      }),
    }

    const out = translateResponsesStreamEvent(event, state)

    expect(out).toEqual([
      {
        type: "message_start",
        message: {
          id: "resp_1",
          type: "message",
          role: "assistant",
          content: [],
          model: "gpt-5.5",
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 100,
            output_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      },
    ])
    expect(state.messageStartSent).toBe(true)
  })

  test("subtracts cached tokens in the message_start usage", () => {
    const state = createResponsesStreamState()
    const out = translateResponsesStreamEvent(
      {
        type: "response.created",
        sequence_number: 0,
        response: mkResult({
          usage: {
            input_tokens: 100,
            output_tokens: 0,
            total_tokens: 100,
            input_tokens_details: { cached_tokens: 30 },
          },
        }),
      },
      state,
    )

    const [messageStart] = out
    expect(messageStart).toMatchObject({
      type: "message_start",
      message: {
        usage: {
          input_tokens: 70,
          output_tokens: 0,
          cache_read_input_tokens: 30,
        },
      },
    })
  })

  test("opens a text block and streams a text_delta", () => {
    const state = createResponsesStreamState()
    const out = translateResponsesStreamEvent(
      {
        type: "response.output_text.delta",
        content_index: 0,
        delta: "Hello",
        item_id: "m1",
        output_index: 0,
        sequence_number: 1,
      },
      state,
    )

    expect(out).toEqual([
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      },
    ])
  })

  test("opens a tool_use block for a function_call output item", () => {
    const state = createResponsesStreamState()
    const out = translateResponsesStreamEvent(
      {
        type: "response.output_item.added",
        output_index: 0,
        sequence_number: 1,
        item: {
          type: "function_call",
          call_id: "call_1",
          name: "get_weather",
          arguments: "",
        },
      },
      state,
    )

    expect(out).toEqual([
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "call_1",
          name: "get_weather",
          input: {},
        },
      },
    ])
    expect(state.hasToolCall).toBe(true)
  })

  test("streams function-call arguments as input_json_delta on the open block", () => {
    const state = createResponsesStreamState()
    translateResponsesStreamEvent(
      {
        type: "response.output_item.added",
        output_index: 0,
        sequence_number: 1,
        item: {
          type: "function_call",
          call_id: "call_1",
          name: "get_weather",
          arguments: "",
        },
      },
      state,
    )

    const out = translateResponsesStreamEvent(
      {
        type: "response.function_call_arguments.delta",
        delta: '{"city":"Paris"}',
        item_id: "call_1",
        output_index: 0,
        sequence_number: 2,
      },
      state,
    )

    expect(out).toEqual([
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"city":"Paris"}' },
      },
    ])
  })

  test("aborts with an error event on a runaway whitespace argument run", () => {
    const state = createResponsesStreamState()
    translateResponsesStreamEvent(
      {
        type: "response.output_item.added",
        output_index: 0,
        sequence_number: 1,
        item: {
          type: "function_call",
          call_id: "call_1",
          name: "get_weather",
          arguments: "",
        },
      },
      state,
    )

    const out = translateResponsesStreamEvent(
      {
        type: "response.function_call_arguments.delta",
        delta: "\n".repeat(21),
        item_id: "call_1",
        output_index: 0,
        sequence_number: 2,
      },
      state,
    )

    // Open tool_use block is closed, then an api_error event is emitted.
    expect(out).toEqual([
      { type: "content_block_stop", index: 0 },
      {
        type: "error",
        error: {
          type: "api_error",
          message:
            "Received function call arguments delta containing more than 20 consecutive whitespace characters.",
        },
      },
    ])
    expect(state.messageCompleted).toBe(true)
  })

  test("closes open blocks and emits message_delta + message_stop on completion", () => {
    const state = createResponsesStreamState()

    // Drive a realistic sequence so a text block is open at completion time.
    translateResponsesStreamEvent(
      {
        type: "response.created",
        sequence_number: 0,
        response: mkResult({}),
      },
      state,
    )
    translateResponsesStreamEvent(
      {
        type: "response.output_text.delta",
        content_index: 0,
        delta: "Hi",
        item_id: "m1",
        output_index: 0,
        sequence_number: 1,
      },
      state,
    )

    const out = translateResponsesStreamEvent(
      {
        type: "response.completed",
        sequence_number: 2,
        response: mkResult({
          output: [
            {
              id: "m1",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "Hi", annotations: [] }],
            },
          ],
          usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
        }),
      },
      state,
    )

    expect(out).toEqual([
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 100, output_tokens: 20 },
      },
      { type: "message_stop" },
    ])
    expect(state.messageCompleted).toBe(true)
  })

  test("maps a top-level error event to an api_error and completes the stream", () => {
    const state = createResponsesStreamState()
    const out = translateResponsesStreamEvent(
      {
        type: "error",
        code: "server_error",
        message: "upstream exploded",
        param: null,
        sequence_number: 0,
      },
      state,
    )

    expect(out).toEqual([
      {
        type: "error",
        error: { type: "api_error", message: "upstream exploded" },
      },
    ])
    expect(state.messageCompleted).toBe(true)
  })

  test("ignores unrecognized event types", () => {
    const state = createResponsesStreamState()
    const out = translateResponsesStreamEvent(
      {
        type: "response.in_progress",
        sequence_number: 0,
        response: mkResult({}),
      },
      state,
    )
    expect(out).toEqual([])
  })
})

describe("buildErrorEvent", () => {
  test("wraps a message in the Anthropic api_error envelope", () => {
    const event: AnthropicStreamEventData = buildErrorEvent("boom")
    expect(event).toEqual({
      type: "error",
      error: { type: "api_error", message: "boom" },
    })
  })
})

describe("multi-part reasoning summary streaming", () => {
  const summaryDelta = (
    summaryIndex: number,
    delta: string,
  ): ResponseStreamEvent => ({
    type: "response.reasoning_summary_text.delta",
    delta,
    item_id: "rs_1",
    output_index: 0,
    sequence_number: 1,
    summary_index: summaryIndex,
  })

  const summaryPartAdded = (summaryIndex: number): ResponseStreamEvent => ({
    type: "response.reasoning_summary_part.added",
    item_id: "rs_1",
    output_index: 0,
    part: { type: "summary_text", text: "" },
    sequence_number: 1,
    summary_index: summaryIndex,
  })

  test("emits the invisible separator between summary parts", () => {
    const state = createResponsesStreamState()

    const first = translateResponsesStreamEvent(summaryPartAdded(0), state)
    expect(
      first.filter((event) => event.type === "content_block_delta"),
    ).toEqual([])

    translateResponsesStreamEvent(summaryDelta(0, "Part one"), state)

    const second = translateResponsesStreamEvent(summaryPartAdded(1), state)
    expect(second).toEqual([
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "⁣\n\n" },
      },
    ])

    const partTwo = translateResponsesStreamEvent(
      summaryDelta(1, "Part two"),
      state,
    )
    expect(partTwo).toEqual([
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Part two" },
      },
    ])
  })

  test("does not re-emit summary text on done for a part that streamed deltas", () => {
    const state = createResponsesStreamState()
    translateResponsesStreamEvent(summaryDelta(0, "Part one"), state)

    const out = translateResponsesStreamEvent(
      {
        type: "response.reasoning_summary_text.done",
        item_id: "rs_1",
        output_index: 0,
        sequence_number: 2,
        summary_index: 0,
        text: "Part one",
      },
      state,
    )
    expect(out).toEqual([])
  })

  test("emits the full text on done for a part that never streamed deltas", () => {
    const state = createResponsesStreamState()
    translateResponsesStreamEvent(summaryDelta(0, "Part one"), state)

    const out = translateResponsesStreamEvent(
      {
        type: "response.reasoning_summary_text.done",
        item_id: "rs_1",
        output_index: 0,
        sequence_number: 2,
        summary_index: 1,
        text: "Part two",
      },
      state,
    )
    expect(out).toEqual([
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Part two" },
      },
    ])
  })

  test("skips the placeholder thinking text when the block already streamed deltas", () => {
    const state = createResponsesStreamState()
    translateResponsesStreamEvent(summaryDelta(0, "Real thinking"), state)

    const out = translateResponsesStreamEvent(
      {
        type: "response.output_item.done",
        output_index: 0,
        sequence_number: 3,
        item: {
          id: "rs_1",
          type: "reasoning",
          summary: [],
          encrypted_content: "ENC",
        },
      },
      state,
    )

    expect(out).toEqual([
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "ENC@rs_1" },
      },
    ])
  })

  test("ignores empty reasoning summary deltas", () => {
    const state = createResponsesStreamState()
    const out = translateResponsesStreamEvent(summaryDelta(0, ""), state)
    expect(out).toEqual([])
  })
})
