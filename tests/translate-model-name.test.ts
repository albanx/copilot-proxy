import { describe, expect, test } from "bun:test"

import { translateModelName } from "../src/routes/messages/non-stream-translation"

describe("translateModelName", () => {
  test("passes through Copilot-style dotted ids unchanged", () => {
    expect(translateModelName("claude-sonnet-4.5")).toBe("claude-sonnet-4.5")
    expect(translateModelName("claude-opus-4.6")).toBe("claude-opus-4.6")
    expect(translateModelName("claude-opus-4.6-1m")).toBe("claude-opus-4.6-1m")
    expect(translateModelName("gpt-4.1")).toBe("gpt-4.1")
  })

  test("maps new Anthropic ids with date + minor to dotted Copilot ids", () => {
    expect(translateModelName("claude-sonnet-4-5-20250929")).toBe(
      "claude-sonnet-4.5",
    )
    expect(translateModelName("claude-opus-4-1-20250805")).toBe(
      "claude-opus-4.1",
    )
    expect(translateModelName("claude-opus-4-5-20251029")).toBe(
      "claude-opus-4.5",
    )
    expect(translateModelName("claude-haiku-4-5-20251001")).toBe(
      "claude-haiku-4.5",
    )
  })

  test("maps new Anthropic ids without minor version", () => {
    expect(translateModelName("claude-sonnet-4-20250514")).toBe(
      "claude-sonnet-4",
    )
    expect(translateModelName("claude-opus-4-20250514")).toBe("claude-opus-4")
  })

  test("maps legacy Anthropic ids (claude-<major>-<minor>-<family>)", () => {
    expect(translateModelName("claude-3-5-sonnet-20241022")).toBe(
      "claude-sonnet-3.5",
    )
    expect(translateModelName("claude-3-5-haiku-20241022")).toBe(
      "claude-haiku-3.5",
    )
  })

  test("returns unknown ids unchanged", () => {
    expect(translateModelName("gpt-4o")).toBe("gpt-4o")
    expect(translateModelName("some-custom-model")).toBe("some-custom-model")
  })
})
