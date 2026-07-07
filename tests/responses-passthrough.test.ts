import { describe, expect, test } from "bun:test"

import {
  detectVision,
  initiator,
  sanitizePayload,
  type ResponsesPayload,
} from "../src/services/copilot/create-responses"
import { modelSupportsResponses } from "../src/routes/responses/handler"
import { type Model } from "../src/services/copilot/get-models"

/** Build a minimal Model, overriding only the fields a test cares about. */
function mkModel(overrides: Partial<Model>): Model {
  return {
    capabilities: {
      family: "test",
      object: "model_capabilities",
      tokenizer: "o200k_base",
      type: "chat",
    },
    id: "test-model",
    model_picker_enabled: true,
    name: "Test Model",
    object: "model",
    preview: false,
    vendor: "test",
    version: "1.0",
    ...overrides,
  }
}

describe("initiator", () => {
  test("string input → user", () => {
    expect(initiator({ model: "gpt-5.5", input: "hello" })).toBe("user")
  })

  test("array of only user/system/developer items → user", () => {
    const payload: ResponsesPayload = {
      model: "gpt-5.5",
      input: [
        { role: "developer", content: "be terse" },
        { role: "user", content: "hi" },
      ],
    }
    expect(initiator(payload)).toBe("user")
  })

  test("array containing an assistant item → agent", () => {
    const payload: ResponsesPayload = {
      model: "gpt-5.5",
      input: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "more" },
      ],
    }
    expect(initiator(payload)).toBe("agent")
  })

  test("array containing a function_call item → agent", () => {
    const payload: ResponsesPayload = {
      model: "gpt-5.5",
      input: [
        { role: "user", content: "weather?" },
        { type: "function_call", name: "get_weather", arguments: "{}", call_id: "c1" },
      ],
    }
    expect(initiator(payload)).toBe("agent")
  })

  test("array containing a function_call_output item → agent", () => {
    const payload: ResponsesPayload = {
      model: "gpt-5.5",
      input: [{ type: "function_call_output", call_id: "c1", output: "sunny" }],
    }
    expect(initiator(payload)).toBe("agent")
  })
})

describe("detectVision", () => {
  test("string input → false", () => {
    expect(detectVision({ model: "gpt-5.5", input: "hello" })).toBe(false)
  })

  test("text-only content → false", () => {
    const payload: ResponsesPayload = {
      model: "gpt-5.5",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    }
    expect(detectVision(payload)).toBe(false)
  })

  test("input_image content → true", () => {
    const payload: ResponsesPayload = {
      model: "gpt-5.5",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "what is this?" },
            { type: "input_image", image_url: "data:image/png;base64,AAAA" },
          ],
        },
      ],
    }
    expect(detectVision(payload)).toBe(true)
  })
})

describe("sanitizePayload", () => {
  test("strips non-function tools", () => {
    const payload: ResponsesPayload = {
      model: "gpt-5.5",
      input: "hi",
      tools: [
        { type: "function", name: "f" },
        { type: "web_search" },
        { type: "file_search" },
      ],
    }
    expect(sanitizePayload(payload).tools).toEqual([{ type: "function", name: "f" }])
  })

  test("drops tools AND tool_choice when no function tools remain", () => {
    const payload: ResponsesPayload = {
      model: "gpt-5.5",
      input: "hi",
      tools: [{ type: "web_search" }],
      tool_choice: "required",
    }
    const out = sanitizePayload(payload)
    expect(out.tools).toBeUndefined()
    expect(out.tool_choice).toBeUndefined()
  })

  test("preserves function tools and tool_choice", () => {
    const payload: ResponsesPayload = {
      model: "gpt-5.5",
      input: "hi",
      tools: [{ type: "function", name: "f" }],
      tool_choice: "auto",
    }
    const out = sanitizePayload(payload)
    expect(out.tools).toEqual([{ type: "function", name: "f" }])
    expect(out.tool_choice).toBe("auto")
  })

  test("payload without tools is untouched", () => {
    const payload: ResponsesPayload = { model: "gpt-5.5", input: "hi", temperature: 0.5 }
    expect(sanitizePayload(payload)).toEqual(payload)
  })

  test("preserves unknown passthrough fields", () => {
    const payload: ResponsesPayload = {
      model: "gpt-5.5",
      input: "hi",
      metadata: { foo: "bar" },
      top_p: 0.9,
    }
    const out = sanitizePayload(payload)
    expect(out.metadata).toEqual({ foo: "bar" })
    expect(out.top_p).toBe(0.9)
  })
})

describe("helper robustness on malformed input", () => {
  test("initiator ignores null items → user", () => {
    const payload = {
      model: "gpt-5.5",
      input: [null, { role: "user", content: "hi" }],
    } as unknown as ResponsesPayload
    expect(initiator(payload)).toBe("user")
  })

  test("initiator still detects agent alongside null items", () => {
    const payload = {
      model: "gpt-5.5",
      input: [
        null,
        { type: "function_call", name: "f", arguments: "{}", call_id: "c1" },
      ],
    } as unknown as ResponsesPayload
    expect(initiator(payload)).toBe("agent")
  })

  test("detectVision ignores null items → false", () => {
    const payload = {
      model: "gpt-5.5",
      input: [null],
    } as unknown as ResponsesPayload
    expect(detectVision(payload)).toBe(false)
  })

  test("detectVision ignores null/string content parts → false", () => {
    const payload = {
      model: "gpt-5.5",
      input: [{ role: "user", content: [null, "plain string"] }],
    } as unknown as ResponsesPayload
    expect(detectVision(payload)).toBe(false)
  })
})

describe("sanitizePayload edge cases", () => {
  test("empty tools array → drops tools and tool_choice", () => {
    const payload: ResponsesPayload = {
      model: "gpt-5.5",
      input: "hi",
      tools: [],
      tool_choice: "auto",
    }
    const out = sanitizePayload(payload)
    expect(out.tools).toBeUndefined()
    expect(out.tool_choice).toBeUndefined()
  })

  test("does not mutate the original payload when stripping", () => {
    const payload: ResponsesPayload = {
      model: "gpt-5.5",
      input: "hi",
      tools: [
        { type: "function", name: "f" },
        { type: "web_search" },
      ],
    }
    const snapshot = structuredClone(payload)
    sanitizePayload(payload)
    expect(payload).toEqual(snapshot)
  })
})

describe("modelSupportsResponses", () => {
  test("advertised endpoints including /responses → true", () => {
    const model = mkModel({
      id: "gpt-5.5",
      supported_endpoints: ["/chat/completions", "/responses"],
    })
    expect(modelSupportsResponses(model)).toBe(true)
  })

  test("advertised endpoints excluding /responses → false", () => {
    const model = mkModel({
      id: "gpt-5.5",
      supported_endpoints: ["/chat/completions"],
    })
    expect(modelSupportsResponses(model)).toBe(false)
  })

  test("undefined model (list not loaded) → true (permissive)", () => {
    expect(modelSupportsResponses(undefined)).toBe(true)
  })

  test("known model without any advertised endpoints → true (permissive)", () => {
    const model = mkModel({ id: "gpt-5.5" })
    expect(modelSupportsResponses(model)).toBe(true)
  })

  test("empty endpoints array → true (permissive)", () => {
    const model = mkModel({ id: "gpt-5.5", supported_endpoints: [] })
    expect(modelSupportsResponses(model)).toBe(true)
  })
})
