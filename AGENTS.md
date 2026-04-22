# AGENTS.md

Single source of truth for AI agents working in this repo.

## What this is

A reverse-engineered local proxy that exposes **GitHub Copilot's chat API** as
**OpenAI-compatible** (`/v1/chat/completions`, `/v1/models`, `/v1/embeddings`)
and **Anthropic-compatible** (`/v1/messages`, `/v1/messages/count_tokens`)
endpoints. Lets tools like Claude Code use Copilot as a backend.

- Runtime: **Bun** (>= 1.2.x) — not Node/npm
- HTTP: **Hono** served via **srvx**
- CLI: **citty**
- Distributed via `bun run start` (built bundle at `dist/main.js`)

## Scope guardrails

Keep this project small: a local bridge with only `auth` and `start` CLI
commands. No Docker tooling in source, no external dashboards. The README
ships Docker examples for users, but don't add Docker-specific code paths
into the codebase.

## Commands

All scripts use Bun, not Node/npm.

| Task        | Command                                       |
| ----------- | --------------------------------------------- |
| Install     | `bun install`                                 |
| Dev (watch) | `bun run dev`                                 |
| Build       | `bun run build` (tsdown → `dist/main.js`)     |
| Start prod  | `bun run start`                               |
| Lint        | `bun run lint` (cached) / `bun run lint:all`  |
| Lint staged | `bunx lint-staged`                            |
| Typecheck   | `bun run typecheck` (`tsc --noEmit`)          |
| Dead code   | `bun run knip`                                |
| Test all    | `bun test` (Bun's built-in runner, not Jest)  |
| Test one    | `bun test tests/anthropic-request.test.ts`    |
| Test filter | `bun test -t "partial test name"`             |

Pre-commit hook (`simple-git-hooks` + `lint-staged`) runs `bun run lint --fix` on staged files.

## Repo layout

```
src/
  main.ts                       # citty entry; subCommands: { auth, start }
  auth.ts                       # `auth` subcommand (GitHub device-flow login only)
  start.ts                      # `start` subcommand (boots server, owns CLI flags)
  server.ts                     # Hono app; mounts routes at root AND under /v1/
  lib/
    state.ts                    # SINGLETON `state` object — canonical runtime config
    api-config.ts               # copilotBaseUrl(state), header builders
    token.ts                    # setupGitHubToken / setupCopilotToken
    paths.ts                    # OS-specific token storage paths
    rate-limit.ts               # checkRateLimit(state)
    approval.ts                 # awaitApproval() for --manual
    error.ts                    # HTTPError + forwardError(c, err)
    proxy.ts                    # initProxyFromEnv() via proxy-from-env + undici
    request-logger.ts           # Hono middleware
    tokenizer.ts                # gpt-tokenizer wrapper
    shell.ts, utils.ts          # misc
  routes/
    chat-completions/{route,handler}.ts
    embeddings/route.ts
    models/route.ts
    messages/                   # Anthropic compat (most complex area)
      route.ts, handler.ts
      anthropic-types.ts        # payload types + AnthropicStreamState
      non-stream-translation.ts # translateToOpenAI / translateToAnthropic
      stream-translation.ts     # translateChunkToAnthropicEvents(chunk, streamState)
      count-tokens-handler.ts   # /v1/messages/count_tokens
      utils.ts
  services/
    get-vscode-version.ts       # VS Code-style header values
    copilot/{create-chat-completions,create-embeddings,get-models}.ts
    github/{get-device-code,poll-access-token,get-copilot-token,get-user}.ts
tests/                          # *.test.ts at repo root, NOT colocated
  anthropic-request.test.ts
  anthropic-response.test.ts
  create-chat-completions.test.ts
  translate-model-name.test.ts
```

## How `start` boots

1. Parse CLI args (citty) → push values into the `state` singleton.
2. `ensurePaths()` creates token storage dirs; `cacheVSCodeVersion()` fetches latest VS Code version for upstream headers.
3. `setupGitHubToken()` — device-code OAuth flow (or use `--github-token`); persists token to disk.
4. `setupCopilotToken()` — trades GitHub token for short-lived Copilot token.
5. `cacheModels()` populates `state.models`.
6. Optional `--claude-code`: prompts for primary + small model, copies env-var launch command to clipboard.
7. `serve()` starts Hono with `idleTimeout: 0` (critical — keeps SSE streams alive).

## Critical conventions

- **`state` singleton (`src/lib/state.ts`)** is the runtime config. **Read/mutate it directly** — don't thread config through parameters.
- **Dual route mounting**: every OpenAI-shaped endpoint is mounted at both `/<path>` and `/v1/<path>` in `server.ts`. Preserve this when adding endpoints.
- **Mutating handlers must start with**:
  ```ts
  await checkRateLimit(state)
  if (state.manualApprove) await awaitApproval()
  ```
- **Errors**: throw `HTTPError` from `src/lib/error.ts`; serialize with `forwardError(c, err)`. Don't swallow.
- **Imports**: use `~/*` alias for anything under `src/`; relative imports OK within the same feature folder. ESNext modules only (no CommonJS).
- **TypeScript**: `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `erasableSyntaxOnly` all on. Use `import type` for type-only imports. Avoid `any`.
- **Naming**: `camelCase` for variables/functions, `PascalCase` for types/classes.
- **Validation**: handlers use `c.req.json<T>()` typed casts (no Zod at the edge despite zod being a dep). Match the existing pattern.
- **Logging**: use `consola` (`consola.info/debug/error`); `--verbose` raises level. No `console.log`.
- **CLI flags**: add via citty `args` in `src/start.ts` (or `auth.ts`), then push to `state` before `serve()`. Don't read `process.argv` directly.
- **Proxy**: `--proxy-env` wires `HTTP(S)_PROXY` via `proxy-from-env` + `undici`. Use `undici`'s fetch (not global) for upstream calls if proxy support matters.
- **Style**: only comment code that needs clarification; otherwise let code speak.
- **Linting**: standard ESLint flat config (`@eslint/js` recommended + `typescript-eslint` recommended + `eslint-config-prettier`). Formatting via plain `prettier` with a minimal `.prettierrc.json`.

## Anthropic translation (most complex area)

`/v1/messages` does full bidirectional translation between Anthropic Messages API and OpenAI Chat Completions:

- **Non-streaming**: `translateToOpenAI()` before upstream → `translateToAnthropic()` after.
- **Streaming**: `translateChunkToAnthropicEvents(chunk, streamState)` converts each OpenAI SSE chunk into one or more Anthropic SSE events (`message_start`, `content_block_start/delta/stop`, tool-use blocks…). **Mutate `streamState` across chunks — don't recreate it per chunk.**
- **Token counting**: `/v1/messages/count_tokens` uses `gpt-tokenizer` via `src/lib/tokenizer.ts`.
- When changing Anthropic behavior, update **both** stream and non-stream paths and run all 4 tests in `tests/`.

## Subcommands actually defined

`src/main.ts` only registers `{ auth, start }`. The README mentions
`check-usage` and `debug`, but they are not currently in the source —
verify before referencing.
