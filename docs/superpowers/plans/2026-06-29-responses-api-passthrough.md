# Native /responses Passthrough Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a native OpenAI Responses API endpoint (`POST /responses`) so Responses-only Copilot models (e.g. GPT-5.5) are reachable through the proxy instead of returning a 404.

**Architecture:** Native passthrough — the client speaks the OpenAI Responses format, the proxy forwards faithfully to Copilot upstream `/responses`, and streams results back preserving semantic SSE event names. No translation to/from Chat Completions. Mirrors the existing `route → handler → service` split and the `messages` handler's streaming pattern.

**Tech Stack:** TypeScript, Hono, `fetch-event-stream` (`events`), `hono/streaming` (`streamSSE`), `consola`, `bun:test`.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/services/copilot/create-responses.ts` | Types (`ResponsesPayload`, `ResponsesInputItem`, `ResponsesTool`); pure helpers (`initiator`, `detectVision`, `sanitizePayload`); network call `createResponses`. |
| `src/routes/responses/handler.ts` | Orchestration: rate-limit, parse, sanitize, log, approval, call service, branch stream/json. |
| `src/routes/responses/route.ts` | Hono route; wraps handler in `try/catch → forwardError`. |
| `src/server.ts` | Register `server.route("/responses", responsesRoutes)`. |
| `tests/responses-passthrough.test.ts` | Unit tests for the three pure helpers. |

---

## Task 1: Types + pure helpers (TDD)

**Files:**
- Create: `src/services/copilot/create-responses.ts`
- Test: `tests/responses-passthrough.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/responses-passthrough.test.ts`:

```ts
import { describe, expect, test } from "bun:test"

import {
  detectVision,
  initiator,
  sanitizePayload,
  type ResponsesPayload,
} from "../src/services/copilot/create-responses"

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/responses-passthrough.test.ts`
Expected: FAIL — cannot resolve module `../src/services/copilot/create-responses`.

- [ ] **Step 3: Write the types + helpers**

Create `src/services/copilot/create-responses.ts`:

```ts
import consola from "consola"

export interface ResponsesInputItem {
  type?: string
  role?: string
  content?: unknown
  [key: string]: unknown
}

export interface ResponsesTool {
  type?: string
  [key: string]: unknown
}

export interface ResponsesPayload {
  model: string
  input: string | Array<ResponsesInputItem>
  instructions?: string | null
  max_output_tokens?: number | null
  stream?: boolean | null
  tools?: Array<ResponsesTool> | null
  tool_choice?: unknown
  reasoning?: { effort?: string } | null
  [key: string]: unknown
}

/**
 * Decide the X-Initiator header value. Mirrors the chat-completions rule
 * (agent when history contains assistant/tool turns) adapted to the Responses
 * `input` shape: the Chat Completions `tool` role maps to the Responses
 * `function_call` / `function_call_output` items.
 */
export function initiator(payload: ResponsesPayload): "agent" | "user" {
  const { input } = payload
  if (!Array.isArray(input)) return "user"
  const isAgent = input.some(
    (item) =>
      item.role === "assistant"
      || item.type === "function_call"
      || item.type === "function_call_output",
  )
  return isAgent ? "agent" : "user"
}

/** Best-effort scan for image content so we can set the copilot-vision header. */
export function detectVision(payload: ResponsesPayload): boolean {
  const { input } = payload
  if (!Array.isArray(input)) return false
  return input.some((item) => {
    const content = item.content
    if (!Array.isArray(content)) return false
    return content.some(
      (part) =>
        typeof part === "object"
        && part !== null
        && (part as { type?: string }).type === "input_image",
    )
  })
}

/**
 * Copilot's /responses only accepts `type: "function"` tools. Strip any built-in
 * tools (web_search, file_search, code_interpreter, computer_use_preview, …).
 * When no function tools remain, drop both `tools` and a dangling `tool_choice`
 * so upstream doesn't error on e.g. tool_choice:"required" with no tools.
 */
export function sanitizePayload(payload: ResponsesPayload): ResponsesPayload {
  if (!Array.isArray(payload.tools)) return payload

  const supportedTools = payload.tools.filter((tool) => tool.type === "function")
  const stripped = payload.tools.length - supportedTools.length
  if (stripped > 0) {
    consola.debug(`Stripped ${stripped} unsupported tool(s) from request`)
  }

  if (supportedTools.length > 0) {
    return { ...payload, tools: supportedTools }
  }

  const next = { ...payload }
  delete next.tools
  delete next.tool_choice
  return next
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/responses-passthrough.test.ts`
Expected: PASS — all `initiator`, `detectVision`, `sanitizePayload` tests green.

- [ ] **Step 5: Commit**

```bash
git add src/services/copilot/create-responses.ts tests/responses-passthrough.test.ts
git commit -m "feat: add Responses API payload types and helpers"
```

---

## Task 2: `createResponses` network call

**Files:**
- Modify: `src/services/copilot/create-responses.ts` (append; add imports)

- [ ] **Step 1: Add imports**

At the top of `src/services/copilot/create-responses.ts`, below the existing `import consola from "consola"` line, add:

```ts
import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
```

- [ ] **Step 2: Append the service function**

At the end of `src/services/copilot/create-responses.ts`, add:

```ts
/**
 * Forward a Responses-format payload to Copilot upstream `/responses`.
 * Returns the raw streaming `Response` when `payload.stream` is set (the handler
 * iterates it via `events()` — mirrors the messages handler); otherwise returns
 * the parsed JSON object.
 */
export const createResponses = async (
  payload: ResponsesPayload,
): Promise<Response | Record<string, unknown>> => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const headers: Record<string, string> = {
    ...copilotHeaders(state, detectVision(payload)),
    "X-Initiator": initiator(payload),
  }

  const response = await fetch(`${copilotBaseUrl(state)}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    consola.error("Failed to create responses", response)
    throw new HTTPError("Failed to create responses", response)
  }

  if (payload.stream) {
    return response
  }

  return (await response.json()) as Record<string, unknown>
}
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS — no type errors. (No new unit test: this is network I/O, exercised by the smoke test in Task 5.)

- [ ] **Step 4: Commit**

```bash
git add src/services/copilot/create-responses.ts
git commit -m "feat: add createResponses upstream forwarder"
```

---

## Task 3: Handler

**Files:**
- Create: `src/routes/responses/handler.ts`

- [ ] **Step 1: Write the handler**

Create `src/routes/responses/handler.ts`:

```ts
import type { Context } from "hono"

import consola from "consola"
import { events } from "fetch-event-stream"
import { streamSSE } from "hono/streaming"

import { copilotBaseUrl } from "~/lib/api-config"
import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  createResponses,
  sanitizePayload,
  type ResponsesPayload,
} from "~/services/copilot/create-responses"

export async function handleResponses(c: Context) {
  await checkRateLimit(state)

  const rawPayload = await c.req.json<ResponsesPayload>()
  consola.debug(
    "Responses API request payload:",
    JSON.stringify(rawPayload).slice(-400),
  )

  const payload = sanitizePayload(rawPayload)

  c.set("logInfo", {
    model: payload.model,
    upstream: `${copilotBaseUrl(state)}/responses`,
    stream: payload.stream ?? false,
    responseFormat: payload.stream ? "sse" : "json",
    account: state.accountType,
  })

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await createResponses(payload)

  // Streaming: response is a raw fetch Response — re-emit each SSE event,
  // preserving the semantic event name (response.output_text.delta, etc.)
  // so Responses-API clients that dispatch on `event:` work correctly.
  if (response instanceof Response) {
    consola.debug("Streaming response from Copilot /responses")
    return streamSSE(c, async (stream) => {
      for await (const rawEvent of events(response)) {
        if (rawEvent.data === "[DONE]") {
          break
        }
        if (!rawEvent.data) {
          continue
        }
        const parsed = JSON.parse(rawEvent.data) as { type?: string }
        await stream.writeSSE({
          event: parsed.type ?? "message",
          data: rawEvent.data,
        })
      }
    })
  }

  // Non-streaming: response is a parsed JSON object — forward verbatim.
  consola.debug(
    "Non-streaming response from Copilot /responses:",
    JSON.stringify(response).slice(-400),
  )
  return c.json(response)
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/routes/responses/handler.ts
git commit -m "feat: add /responses handler with semantic SSE passthrough"
```

---

## Task 4: Route + server registration

**Files:**
- Create: `src/routes/responses/route.ts`
- Modify: `src/server.ts`

- [ ] **Step 1: Write the route**

Create `src/routes/responses/route.ts`:

```ts
import { Hono } from "hono"

import { forwardError } from "~/lib/error"

import { handleResponses } from "./handler"

export const responsesRoutes = new Hono()

responsesRoutes.post("/", async (c) => {
  try {
    return await handleResponses(c)
  } catch (error) {
    return await forwardError(c, error)
  }
})
```

- [ ] **Step 2: Register in server.ts**

In `src/server.ts`, add the import alongside the other route imports (after the `modelRoutes` import line):

```ts
import { responsesRoutes } from "./routes/responses/route"
```

Then add the route registration immediately after the `server.route("/embeddings", embeddingRoutes)` line:

```ts
server.route("/responses", responsesRoutes)
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/routes/responses/route.ts src/server.ts
git commit -m "feat: register /responses route"
```

---

## Task 5: Full verification + manual smoke test

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `bun test`
Expected: PASS — including `tests/responses-passthrough.test.ts`.

- [ ] **Step 2: Typecheck + lint**

Run: `bun run typecheck && bun run lint:all`
Expected: both PASS, no errors.

- [ ] **Step 3: Manual smoke test — route exists (no more 404)**

Start the server in one shell: `bun run dev`

In another shell, confirm the path now resolves to the handler (not Hono's catch-all 404). Without a valid Copilot token this should surface an **upstream/auth error forwarded by `forwardError`**, NOT a 404 "no route" from the proxy:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:4141/responses \
  -H "content-type: application/json" \
  -d '{"model":"gpt-5.5","input":"hello"}'
```

Expected: any status **except** a bare 404 from the router (e.g. 401/400/500 forwarded from upstream, or 200 with a valid token). A 404 here means the route is not registered — revisit Task 4.

> Note: the proxy default port is 4141; adjust the URL if you run with a different `--port`.

- [ ] **Step 4: Manual smoke test — streaming (requires a working Copilot token + Responses-capable model)**

```bash
curl -N -X POST http://localhost:4141/responses \
  -H "content-type: application/json" \
  -d '{"model":"gpt-5.5","input":"say hi in 3 words","stream":true}'
```

Expected: a stream of SSE frames whose `event:` lines carry semantic names (e.g. `response.output_text.delta`, `response.completed`), with matching JSON `data:` payloads.

- [ ] **Step 5: Final commit (if any lint auto-fixes were applied)**

```bash
git add -A
git commit -m "chore: lint fixes for /responses route" || echo "nothing to commit"
```

---

## Self-Review Notes

- **Spec coverage:** `/responses`-only route (Task 4) ✓; native passthrough, no translation (Tasks 2–3) ✓; `X-Initiator` proper detection (Task 1 `initiator`) ✓; vision flag (Task 1 `detectVision`) ✓; `sanitizePayload` incl. dangling `tool_choice` drop (Task 1) ✓; semantic SSE streaming (Task 3) ✓; `forwardError` wrap (Task 4) ✓; no token counting / no model gating (omitted by design) ✓; helper unit tests (Task 1) ✓.
- **Type consistency:** `ResponsesPayload` / `initiator` / `detectVision` / `sanitizePayload` / `createResponses` names match across service, handler, and tests. Service returns `Response | Record<string, unknown>`; handler discriminates with `instanceof Response` (streaming) — consistent with the `messages` handler.
- **No placeholders:** every code step contains complete code; every run step has an exact command + expected result.
