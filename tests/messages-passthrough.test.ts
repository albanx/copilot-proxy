import { describe, expect, test } from "bun:test"

import {
  buildAnthropicBetaHeader,
  detectVision,
  initiator,
  supportsAnthropicMessages,
} from "../src/services/copilot/create-messages"
import { type Model } from "../src/services/copilot/get-models"
import { type AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types"

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
  test("only user messages → user", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-fable-5",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    }
    expect(initiator(payload)).toBe("user")
  })

  test("history containing an assistant message → agent", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-fable-5",
      max_tokens: 100,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "more" },
      ],
    }
    expect(initiator(payload)).toBe("agent")
  })

  test("user message carrying a tool_result block → agent", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-fable-5",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "sunny" },
          ],
        },
      ],
    }
    expect(initiator(payload)).toBe("agent")
  })

  test("ignores null items → user", () => {
    const payload = {
      model: "claude-fable-5",
      max_tokens: 100,
      messages: [null, { role: "user", content: "hi" }],
    } as unknown as AnthropicMessagesPayload
    expect(initiator(payload)).toBe("user")
  })

  test("still detects agent alongside null items", () => {
    const payload = {
      model: "claude-fable-5",
      max_tokens: 100,
      messages: [null, { role: "assistant", content: "hello" }],
    } as unknown as AnthropicMessagesPayload
    expect(initiator(payload)).toBe("agent")
  })
})

describe("detectVision", () => {
  test("string content → false", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-fable-5",
      max_tokens: 100,
      messages: [{ role: "user", content: "hello" }],
    }
    expect(detectVision(payload)).toBe(false)
  })

  test("text-only blocks → false", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-fable-5",
      max_tokens: 100,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    }
    expect(detectVision(payload)).toBe(false)
  })

  test("image block → true", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-fable-5",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "AAAA",
              },
            },
          ],
        },
      ],
    }
    expect(detectVision(payload)).toBe(true)
  })

  test("ignores null items → false", () => {
    const payload = {
      model: "claude-fable-5",
      max_tokens: 100,
      messages: [null],
    } as unknown as AnthropicMessagesPayload
    expect(detectVision(payload)).toBe(false)
  })
})

describe("supportsAnthropicMessages", () => {
  test("advertised supported_endpoints including /v1/messages → true", () => {
    const model = mkModel({
      id: "claude-sonnet-4.5",
      vendor: "anthropic",
      supported_endpoints: ["/chat/completions", "/v1/messages"],
    })
    expect(supportsAnthropicMessages(model, "claude-sonnet-4.5")).toBe(true)
  })

  test("advertised endpoints are authoritative — excludes /v1/messages → false", () => {
    // Even for an anthropic-vendor claude id, explicit endpoints win.
    const model = mkModel({
      id: "claude-sonnet-4.5",
      vendor: "anthropic",
      supported_endpoints: ["/chat/completions"],
    })
    expect(supportsAnthropicMessages(model, "claude-sonnet-4.5")).toBe(false)
  })

  test("no endpoints but anthropic vendor → true", () => {
    const model = mkModel({ id: "claude-fable-5", vendor: "anthropic" })
    expect(supportsAnthropicMessages(model, "claude-fable-5")).toBe(true)
  })

  test("no endpoints, vendor casing tolerated → true", () => {
    const model = mkModel({ id: "claude-fable-5", vendor: "Anthropic" })
    expect(supportsAnthropicMessages(model, "claude-fable-5")).toBe(true)
  })

  test("undefined model but claude- id prefix → true", () => {
    expect(supportsAnthropicMessages(undefined, "claude-fable-5")).toBe(true)
  })

  test("undefined model, non-claude id → false", () => {
    expect(supportsAnthropicMessages(undefined, "gpt-5.5")).toBe(false)
  })

  test("known non-anthropic model without endpoints → false", () => {
    const model = mkModel({ id: "gpt-5.5", vendor: "openai" })
    expect(supportsAnthropicMessages(model, "gpt-5.5")).toBe(false)
  })
})

describe("buildAnthropicBetaHeader", () => {
  test("no thinking → undefined", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-fable-5",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    }
    expect(buildAnthropicBetaHeader(payload)).toBeUndefined()
  })

  test("thinking enabled → interleaved-thinking beta", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-fable-5",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 1024 },
    }
    expect(buildAnthropicBetaHeader(payload)).toBe(
      "interleaved-thinking-2025-05-14",
    )
  })

  test("thinking adaptive with a budget → undefined (adaptive suppresses beta)", () => {
    const payload = {
      model: "claude-fable-5",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "adaptive", budget_tokens: 1024 },
    } as unknown as AnthropicMessagesPayload
    expect(buildAnthropicBetaHeader(payload)).toBeUndefined()
  })

  test("thinking adaptive without a budget → undefined", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-fable-5",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "adaptive" },
    }
    expect(buildAnthropicBetaHeader(payload)).toBeUndefined()
  })

  test("thinking disabled → undefined", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-fable-5",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "disabled" },
    }
    expect(buildAnthropicBetaHeader(payload)).toBeUndefined()
  })

  const basePayload: AnthropicMessagesPayload = {
    model: "claude-fable-5",
    max_tokens: 100,
    messages: [{ role: "user", content: "hi" }],
  }

  test("inbound allow-listed flag forwarded verbatim", () => {
    expect(
      buildAnthropicBetaHeader(basePayload, "context-management-2025-06-27"),
    ).toBe("context-management-2025-06-27")
  })

  test("inbound multiple allow-listed flags forwarded, order preserved", () => {
    expect(
      buildAnthropicBetaHeader(
        basePayload,
        "context-management-2025-06-27,advanced-tool-use-2025-11-20",
      ),
    ).toBe("context-management-2025-06-27,advanced-tool-use-2025-11-20")
  })

  test("inbound unknown flag dropped → undefined", () => {
    expect(
      buildAnthropicBetaHeader(basePayload, "some-unreleased-beta-2099-01-01"),
    ).toBeUndefined()
  })

  test("inbound mix keeps only allow-listed flags", () => {
    expect(
      buildAnthropicBetaHeader(
        basePayload,
        "unknown-beta, interleaved-thinking-2025-05-14 ,another-unknown",
      ),
    ).toBe("interleaved-thinking-2025-05-14")
  })

  test("inbound beta takes precedence over a derived thinking budget", () => {
    const payload: AnthropicMessagesPayload = {
      ...basePayload,
      thinking: { type: "enabled", budget_tokens: 2048 },
    }
    // Even though the payload would derive interleaved-thinking, an inbound
    // header that survives filtering wins.
    expect(
      buildAnthropicBetaHeader(payload, "context-management-2025-06-27"),
    ).toBe("context-management-2025-06-27")
  })

  test("inbound all-unknown with a thinking budget → undefined (no fallback)", () => {
    const payload: AnthropicMessagesPayload = {
      ...basePayload,
      thinking: { type: "enabled", budget_tokens: 2048 },
    }
    // An inbound header is present (branch taken); after filtering nothing
    // survives, so we do NOT fall back to deriving interleaved-thinking.
    expect(buildAnthropicBetaHeader(payload, "totally-unknown")).toBeUndefined()
  })

  test("inbound empty string → falls through to payload derivation", () => {
    const payload: AnthropicMessagesPayload = {
      ...basePayload,
      thinking: { type: "enabled", budget_tokens: 2048 },
    }
    // Empty inbound is falsy, so the derivation path runs and yields the beta.
    expect(buildAnthropicBetaHeader(payload, "")).toBe(
      "interleaved-thinking-2025-05-14",
    )
  })
})
