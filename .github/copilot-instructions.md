# Copilot API Proxy — Agent Instructions

Reverse-engineered proxy that exposes GitHub Copilot's internal chat API as OpenAI-compatible (`/v1/chat/completions`, `/v1/models`, `/v1/embeddings`) and Anthropic-compatible (`/v1/messages`) endpoints. Runtime is **Bun** (>= 1.2.x), HTTP server is **Hono**, CLI is **citty**.

## Commands

All scripts use Bun, not Node/npm.

- Install: `bun install`
- Dev (watch): `bun run dev`
- Build: `bun run build` (tsdown → `dist/main.js`)
- Start prod: `bun run start`
- Lint: `bun run lint` (ESLint flat config with `@eslint/js` + `typescript-eslint` + `eslint-config-prettier`; uses cache)
- Lint whole repo: `bun run lint:all`
- Typecheck: `bun run typecheck` (`tsc` — `noEmit`)
- Dead-code check: `bun run knip`
- Test all: `bun test` (Bun's built-in runner, not Jest/Vitest)
- Test single file: `bun test tests/anthropic-request.test.ts`
- Test by name filter: `bun test -t "partial test name"`

Pre-commit hook runs `bun run lint --fix` on staged files via `simple-git-hooks` + `lint-staged`.

## Architecture

Entry is `src/main.ts` → citty `defineCommand` with four subcommands: `auth`, `start`, `check-usage`, `debug` (files of the same name in `src/`).

The `start` subcommand:
1. Authenticates (device flow) and persists a GitHub OAuth token at an OS-specific path (`src/lib/paths.ts`); trades it for a short-lived Copilot token.
2. Populates the singleton `state` object in `src/lib/state.ts` (`githubToken`, `copilotToken`, `accountType`, `models`, rate-limit config, flags). **This module-level `state` is the canonical runtime config — read/mutate it, don't pass config through parameters.**
3. Boots the Hono app from `src/server.ts` via `srvx`.

`src/server.ts` mounts route groups twice (once at root, once under `/v1/`) for client compatibility. Each route group lives in `src/routes/<name>/` with a `route.ts` (Hono router) and a `handler.ts`.

Upstream Copilot calls live in `src/services/copilot/` (`create-chat-completions.ts`, `create-embeddings.ts`, `get-models.ts`). These call Copilot's real endpoints (`copilotBaseUrl(state)` in `src/lib/api-config.ts`) with VS Code-style headers (see `src/services/get-vscode-version.ts`). Auth-flow helpers for GitHub device-code login are under `src/services/github/`.

### Anthropic compatibility (most complex part)

`/v1/messages` does full bidirectional translation between Anthropic Messages API and OpenAI Chat Completions:

- `src/routes/messages/anthropic-types.ts` — Anthropic payload types + `AnthropicStreamState` used across streaming chunks.
- `non-stream-translation.ts` — `translateToOpenAI(anthropicPayload)` before upstream call, `translateToAnthropic(openAIResponse)` after.
- `stream-translation.ts` — `translateChunkToAnthropicEvents(chunk, streamState)` converts each OpenAI SSE chunk into one or more Anthropic SSE events (`message_start`, `content_block_start/delta/stop`, tool-use blocks, etc.). The `streamState` object carries block indices and open tool calls across chunks — mutate it, don't recreate it per chunk.
- `count-tokens-handler.ts` backs `/v1/messages/count_tokens` using `gpt-tokenizer` (`src/lib/tokenizer.ts`).

When changing Anthropic behavior, update both stream and non-stream paths and run the three test files in `tests/` — they snapshot the translation boundaries.

### Cross-cutting concerns

- **Rate limiting / manual approval**: every mutating handler starts with `await checkRateLimit(state)` and, if `state.manualApprove`, `await awaitApproval()` (`src/lib/rate-limit.ts`, `src/lib/approval.ts`). Keep this ordering when adding new handlers.
- **Errors**: throw `HTTPError` (from `src/lib/error.ts`) for upstream failures; `forwardError(c, err)` serializes them into the response. Don't swallow errors.
- **Proxy**: `--proxy-env` wires `HTTP(S)_PROXY` via `proxy-from-env` + `undici` in `src/lib/proxy.ts`. Use `undici`'s fetch, not global fetch, when talking to Copilot if proxy support matters.

## Conventions

- **Imports**: use the `~/*` alias for anything under `src/` (configured in `tsconfig.json`). Relative imports are fine within the same feature folder (e.g., inside `src/routes/messages/`).
- **TypeScript**: `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `erasableSyntaxOnly` are all on. Use `import type` for type-only imports. Avoid `any`.
- **Validation**: payload parsing currently uses plain `c.req.json<T>()` typed casts, not Zod at the edge, even though `zod` is a dep. Follow existing patterns in the route you're editing rather than introducing new validation layers unprompted.
- **Logging**: use `consola` (`consola.info/debug/error`). `--verbose` raises the level; don't use `console.log`.
- **CLI flags**: add new flags in the relevant `src/<command>.ts` using citty's `args`, then push the value into `state` before `server.listen`. Don't read `process.argv` directly.
- **Tests**: Bun test runner, files named `*.test.ts` in `tests/` at repo root (not colocated). Import from `bun:test`.
- **Dual routing**: when adding a new OpenAI-shaped endpoint, mount it both at `/<path>` and `/v1/<path>` in `src/server.ts` to preserve client compatibility.
