import { describe, expect, test } from "bun:test"

import { buildPromptPreview } from "../src/lib/request-logger"

describe("buildPromptPreview", () => {
  test("returns the last user text from Anthropic /v1/messages blocks", () => {
    const preview = buildPromptPreview({
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "an answer" },
        { role: "user", content: [{ type: "text", text: "second question" }] },
      ],
    })
    expect(preview).toBe("second question")
  })

  test("handles string message content (OpenAI chat)", () => {
    const preview = buildPromptPreview({
      messages: [{ role: "user", content: "hello there" }],
    })
    expect(preview).toBe("hello there")
  })

  test("reads OpenAI Responses input_text blocks", () => {
    const preview = buildPromptPreview({
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    })
    expect(preview).toBe("hi")
  })

  test("reads a bare string Responses input", () => {
    expect(buildPromptPreview({ input: "just a string" })).toBe("just a string")
  })

  test("falls back to an earlier user turn when the last is tool-result-only", () => {
    const preview = buildPromptPreview({
      messages: [
        { role: "user", content: [{ type: "text", text: "the real prompt" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "t1" }] },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "42" }],
        },
      ],
    })
    expect(preview).toBe("the real prompt")
  })

  test("collapses whitespace and newlines into single spaces", () => {
    expect(
      buildPromptPreview({
        messages: [{ role: "user", content: "  line one\n\n\tline   two  " }],
      }),
    ).toBe("line one line two")
  })

  test("strips control characters so ANSI cannot bleed into the terminal", () => {
    const esc = String.fromCharCode(27)
    expect(
      buildPromptPreview({
        messages: [{ role: "user", content: `safe${esc}[31mtext` }],
      }),
    ).toBe("safe [31mtext")
  })

  test("truncates to 80 characters with an ellipsis", () => {
    const long = "x".repeat(200)
    const preview = buildPromptPreview({
      messages: [{ role: "user", content: long }],
    })
    expect(preview).toBe(`${"x".repeat(80)}…`)
    expect(preview).toHaveLength(81)
  })

  test("returns undefined when there is no extractable user text", () => {
    expect(buildPromptPreview({})).toBeUndefined()
    expect(buildPromptPreview({ messages: [] })).toBeUndefined()
    expect(
      buildPromptPreview({ messages: [{ role: "assistant", content: "hi" }] }),
    ).toBeUndefined()
    expect(buildPromptPreview("not an object")).toBeUndefined()
    expect(buildPromptPreview(null)).toBeUndefined()
  })
})
