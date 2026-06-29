# Design: Native OpenAI Responses API Passthrough

**Date:** 2026-06-29
**Status:** Approved (design phase)
**Component:** `copilot-bridge` proxy — new `/responses` endpoint

## Problem

GitHub Copilot's upstream rejects newer models (e.g. GPT-5.5) on `/chat/completions`
with "this model does not support /chat/completions". Those models are only served
on Copilot's OpenAI **Responses API** endpoint (`/responses`). The proxy currently
exposes no `/responses` route, so a client calling it hits Hono's catch-all and
receives a **404 from the proxy**.

This adds native Responses API support so clients using the OpenAI Responses
format can reach GPT-5.5 (and any other Responses-only model) through the proxy.

## Goals

- Expose `POST /responses` speaking the native OpenAI Responses API contract.
- Forward requests faithfully to Copilot upstream `/responses` and stream results back.
- Match existing code standards: the `route → handler → service` split, `forwardError`,
  `copilotHeaders`, rate-limit, and manual-approval patterns already used by
  `/chat/completions`.

## Non-Goals (YAGNI)

- **No translation layer.** Client speaks Responses; upstream speaks Responses. We do
  not convert to/from Chat Completions. (Contract chosen: *native passthrough*.)
- **No model gating in the proxy.** We do not hardcode "gpt-5.5". If a client sends a
  model upstream rejects, `forwardError` surfaces the real upstream status faithfully.
- **No token counting for this route.** The tokenizer expects a `messages` shape; token
  counts are log-only. `logInfo.inputTokens` stays undefined here. (Possible future
  add-on via cheap text extraction — not built now.)
- **No `/v1/responses` alias.** Only `/responses` is registered.
- **`/models` route unchanged.**

## Architecture

Three new files mirroring `src/routes/chat-completions/`, plus one server wire.

```
src/services/copilot/create-responses.ts   service: POST {base}/responses
src/routes/responses/route.ts               Hono route + forwardError wrap
src/routes/responses/handler.ts             rate-limit, approval, sanitize, log, stream/json
src/server.ts                               + server.route("/responses", responsesRoutes)
```

### Data flow

```
client → POST /responses  (Responses-format body)
  → checkRateLimit(state)
  → parse payload (Record<string, unknown> — loose, for passthrough fidelity)
  → sanitizePayload: strip non-"function" tools
  → set logInfo (model, upstream, stream, account)
  → if state.manualApprove: awaitApproval()
  → createResponses(payload)
      → headers = copilotHeaders(state, vision) + { "X-Initiator": initiator(payload) }
      → fetch `${copilotBaseUrl(state)}/responses`
      → !response.ok → throw HTTPError  (→ forwardError preserves upstream status + body)
      → payload.stream ? return events(response)  : return raw Response
  → stream → streamSSE, re-emit each event with event: parsed.type, data: rawEvent.data
  → json   → c.json(await response.json())
```

## Components & Key Decisions

### `create-responses.ts` (service)
Mirrors `create-chat-completions.ts`. Signature:

```ts
export const createResponses = async (
  payload: ResponsesPayload,
): Promise<Response | AsyncIterable<{ data?: string }>>
```

- Throws `Error("Copilot token not found")` when `state.copilotToken` is missing
  (same guard as chat-completions).
- Builds `copilotHeaders(state, vision)` + `X-Initiator`.
- `payload.stream` true → return `events(response)` (from `fetch-event-stream`);
  else return the raw `Response`.
- Non-2xx → `throw new HTTPError("Failed to create responses", response)`.

### `X-Initiator` detection (standard procedure, adapted to Responses `input`)

The chat-completions standard is: `agent` if any message role is `assistant`/`tool`,
else `user`. Adapted to the Responses `input` shape (string OR array of typed items):

```
input is a string                                  → "user"
input is an array containing any of:
   • an item with role === "assistant"
   • an item with type === "function_call"          → "agent"
   • an item with type === "function_call_output"
otherwise                                           → "user"
```

Rationale: the Chat Completions `tool` role maps to the Responses `function_call` /
`function_call_output` items. We deliberately do **not** copy the old fork's hardcoded
`"X-Initiator": "user"`, which under-reports agentic turns. Implemented as a small
local helper in the service (additive; does not touch the working chat path).

### Vision flag
Best-effort scan of `input` items for content of `type === "input_image"`; result
passed to `copilotHeaders(state, vision)`. Defaults to `false` when `input` is a string.

### `sanitizePayload`
Copilot `/responses` only accepts `type: "function"` tools. Strip any other tool
entries (`web_search`, `file_search`, `code_interpreter`, `computer_use_preview`, …)
before forwarding; set `tools` to `undefined` when none remain. Log how many were
stripped at debug level.

### Streaming (semantic event preservation)
Responses-API clients dispatch on the SSE `event:` name (`response.output_text.delta`,
`response.completed`, etc.). So we use `streamSSE` and re-emit each upstream event with
`event: parsed.type` and `data: rawEvent.data` (raw passthrough of the data payload).
Break on `[DONE]`, skip empty `data`. This differs from the chat-completions raw-body
pipe, which only needs `data:` frames.

### `ResponsesPayload` type
Typed for the fields the handler/service read:
`model`, `stream?`, `input` (`string | Array<ResponsesInputItem>`), `instructions?`,
`max_output_tokens?`, `tools?`, `reasoning?` — plus `[key: string]: unknown` so unknown
fields pass through untouched (whole object is `JSON.stringify`-ed). Output is not
parsed (passthrough), so no response types are modeled.

### Logging
Reuse `RequestLogInfo`. Set `model`, `upstream = {base}/responses`, `stream`,
`responseFormat` (`sse` when streaming else `json`), `account`. `inputTokens`/
`outputTokens` left undefined (see Non-Goals).

## Error Handling

`route.ts` wraps the handler in `try/catch → forwardError`, identical to
`chat-completions/route.ts`. Upstream non-2xx becomes `HTTPError`, and `forwardError`
echoes the real status code + body. A request to `/responses` now reaches a real route
(fixing the proxy-originated 404); genuine upstream 4xx/5xx pass through unchanged.

## Testing (`bun:test`, `tests/`)

`tests/responses-passthrough.test.ts`, helper-level (mirrors `translate-model-name.test.ts`):

- **`X-Initiator` detection:**
  - string `input` → `user`
  - array with an `assistant` item → `agent`
  - array with a `function_call` item → `agent`
  - array with a `function_call_output` item → `agent`
  - array of only `user`/`system`/`developer` text items → `user`
- **Vision detection:** `input` array containing `input_image` → `true`; string input → `false`.
- **`sanitizePayload`:** non-function tools stripped; `tools` becomes `undefined` when
  none remain; function tools preserved; payloads without `tools` untouched.
- **Passthrough fidelity:** unknown top-level fields survive into the object handed to fetch.

To verify the helpers are testable in isolation, `initiator`, `detectVision`, and
`sanitizePayload` are exported from the service module.

Validation commands: `bun test`, `bun run typecheck`, `bun run lint`.

## Files Changed Summary

| File | Change |
|------|--------|
| `src/services/copilot/create-responses.ts` | new — service + `ResponsesPayload` types + exported helpers |
| `src/routes/responses/handler.ts` | new — orchestration (rate-limit, sanitize, approval, log, stream/json) |
| `src/routes/responses/route.ts` | new — Hono route + `forwardError` wrap |
| `src/server.ts` | add `server.route("/responses", responsesRoutes)` |
| `tests/responses-passthrough.test.ts` | new — helper unit tests |
