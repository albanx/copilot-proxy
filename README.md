# Copilot API Proxy

> [!WARNING]
> Reverse-engineered proxy of the GitHub Copilot API. Not supported by GitHub and may break unexpectedly. Excessive automated use may trigger GitHub's abuse detection and risk your Copilot access. Use responsibly.
>
> See: [GitHub Acceptable Use Policies](https://docs.github.com/site-policy/acceptable-use-policies/github-acceptable-use-policies) · [GitHub Copilot Terms](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot)

A local proxy that exposes GitHub Copilot as **OpenAI-compatible** (`/v1/chat/completions`, `/v1/models`, `/v1/embeddings`) and **Anthropic-compatible** (`/v1/messages`, `/v1/messages/count_tokens`) endpoints. Use Copilot as a backend for any tool that speaks either API — including [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview).

## Prerequisites

- [Node.js](https://nodejs.org) (for `npx`) **or** [Bun](https://bun.sh) >= 1.2.x
- GitHub account with Copilot subscription (individual, business, or enterprise)

## Quick start (npx)

The fastest way to run the proxy — no clone, no install:

```sh
npx copilot-bridge@latest start
```

Or install globally once and reuse the `copilot-bridge` (or short `copx`) binary:

```sh
npm i -g copilot-bridge
copilot-bridge start
# or
copx start
```

On first run you'll be prompted to authenticate with GitHub via device-code flow. The server then listens on `http://localhost:4141`.

Useful flags:

```sh
npx copilot-bridge start --port 8080                  # custom port
npx copilot-bridge start --host 0.0.0.0               # expose on the network (default: loopback only)
npx copilot-bridge start --account-type business      # force business / enterprise (default: auto-detect)
npx copilot-bridge start --rate-limit 30 --wait       # throttle requests
npx copilot-bridge start --manual                     # approve each request
npx copilot-bridge start --github-token ghp_...       # non-interactive auth
npx copilot-bridge auth                               # only mint a GitHub token
```

## From source

If you want to hack on the code:

```sh
git clone https://github.com/albanx/copilot-proxy.git
cd copilot-proxy
bun install
bun run dev          # watch mode
# or
bun run build && bun run start
```

## Use with Claude Code

With the proxy running, set these environment variables in the terminal where you launch Claude Code:

```sh
export ANTHROPIC_AUTH_TOKEN="llstudio"
export ANTHROPIC_API_KEY=""
export ANTHROPIC_BASE_URL="http://localhost:4141"
```

Then start Claude Code as usual. It will route all requests through the proxy to Copilot.

#### Switching models from inside Claude Code

If you only want to use Anthropic-family models (sonnet, opus, haiku), **don't** set `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, or `ANTHROPIC_DEFAULT_HAIKU_MODEL`. With those unset, Claude Code uses its built-in defaults and the `/model` command works natively — pick sonnet/opus/haiku and the proxy translates the ID to Copilot's matching model (e.g. `claude-sonnet-4-5` → `claude-sonnet-4.5`).

Only pin a model via env vars or `settings.json` if you want to lock to a specific Copilot model (including non-Anthropic ones like `gpt-4.1`, `gpt-5`), since Claude Code's `/model` picker doesn't list those.

#### Optional: configure via `settings.json`

To persist config across sessions, put it in Claude Code's settings file:

- Windows: `C:\Users\<USER>\.claude\settings.json`
- macOS / Linux: `~/.claude/settings.json`

Sample (Anthropic-only, lets `/model` switch freely):

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "lmstudio",
    "ANTHROPIC_BASE_URL": "http://localhost:4141",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "CLAUDE_CODE_USE_POWERSHELL_TOOL": "1",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1"
  },
  "forceLoginMethod": "console",
  "alwaysThinkingEnabled": true,
  "effortLevel": "xhigh",
  "autoUpdatesChannel": "latest",
  "skipDangerousModePermissionPrompt": true
}
```

To pin a specific model instead, add `"ANTHROPIC_MODEL": "claude-opus-4.6"` (or any ID returned by `GET /v1/models`) inside `env`.

#### Reasoning effort

The proxy honors the reasoning effort your client requests, on every routing path:

- Claude Code's `"effortLevel"` setting (or `output_config.effort` / a top-level `reasoning_effort` sent by any client) is forwarded to Copilot.
- The value is clamped to the effort ladder each model actually advertises (e.g. a model without `xhigh` gets its highest supported level instead of a 400).
- When the client sends nothing, the proxy imitates the VS Code Copilot extension's defaults: `xhigh` for GPT-5.3+ models, `high` otherwise.

The effort actually applied is printed on each request log line (`effort=…`).

Or use the interactive helper, which prompts for models and copies the full launch command to your clipboard:

```sh
npx copilot-bridge start --claude-code
```

## CLI options (`start`)

| Option           | Description                                                    | Default      | Alias |
| ---------------- | -------------------------------------------------------------- | ------------ | ----- |
| `--port`         | Port to listen on                                              | `4141`       | `-p`  |
| `--host`         | Interface to bind (`0.0.0.0` to expose on the network/Docker)  | `127.0.0.1`  |       |
| `--verbose`      | Verbose logging                                                | `false`      | `-v`  |
| `--account-type` | `auto`, `individual`, `business`, or `enterprise`              | `auto`       | `-a`  |
| `--manual`       | Approve each request manually                                  | `false`      |       |
| `--rate-limit`   | Minimum seconds between requests                               | none         | `-r`  |
| `--wait`         | Wait on rate limit instead of erroring                         | `false`      | `-w`  |
| `--github-token` | Provide GitHub token directly                                  | none         | `-g`  |
| `--claude-code`  | Print/copy a Claude Code launch command after model selection  | `false`      | `-c`  |
| `--show-token`   | Print GitHub/Copilot tokens on fetch + refresh                 | `false`      |       |
| `--proxy-env`    | Read `HTTP_PROXY`/`HTTPS_PROXY` from env                       | `false`      |       |

## API endpoints

OpenAI-compatible:

| Endpoint                    | Method | Description                                 |
| --------------------------- | ------ | ------------------------------------------- |
| `/v1/chat/completions`      | POST   | Chat completion (streaming + non-stream)    |
| `/v1/responses`             | POST   | Responses API (streaming + non-stream)      |
| `/v1/models`                | GET    | List available Copilot models               |
| `/v1/embeddings`            | POST   | Create embeddings                           |

Anthropic-compatible:

| Endpoint                         | Method | Description                                |
| -------------------------------- | ------ | ------------------------------------------ |
| `/v1/messages`                   | POST   | Messages API (streaming + non-stream)      |
| `/v1/messages/count_tokens`      | POST   | Token count for a message payload          |

Notes:

- All endpoints are also mounted without the `/v1` prefix.
- Both `/v1/chat/completions` and `/v1/messages` accept any model exposed by Copilot — pick a Claude (`claude-opus-4.6`, `claude-sonnet-4.5`, …) or non-Claude (`gpt-4.1`, `gpt-5`, …) model from `/v1/models`. The `/v1/messages` route auto-translates Anthropic-style model IDs (e.g. `claude-sonnet-4-5-20250929`) into Copilot's dotted form, and passes Copilot-native IDs through unchanged.
- Account type is auto-detected from the Copilot token (individual / business / enterprise). Override with `--account-type` only if detection is wrong.

## Security

This proxy hands out your GitHub Copilot subscription to whoever can reach it — **there is no inbound authentication**. Two defaults protect you:

- **It binds to loopback (`127.0.0.1`) only.** Nothing on your network can reach it. Pass `--host 0.0.0.0` to expose it deliberately (Docker, LAN); the server prints a warning when you do, and you should put it behind a reverse proxy that authenticates.
- **Browser requests are restricted to loopback origins.** Without this, any website you visited while the proxy was running could POST to `localhost:4141` from your browser, burn your quota and read the replies. Command-line clients (Claude Code, curl, the OpenAI/Anthropic SDKs) send no `Origin` header and are unaffected.

Your GitHub token is cached at `~/.local/share/copilot-api/github_token` with `0600` permissions. `--show-token` prints tokens to the console — only use it when debugging, and don't paste the output anywhere.

## Tips

- Use `--rate-limit <seconds>` (optionally with `--wait`) to avoid tripping Copilot's abuse detection.
- Account type is auto-detected by default. To force a specific plan, pass `--account-type individual|business|enterprise`. See [GitHub's network routing docs](https://docs.github.com/en/enterprise-cloud@latest/copilot/managing-copilot/managing-github-copilot-in-your-organization/managing-access-to-github-copilot-in-your-organization/managing-github-copilot-access-to-your-organizations-network).
- If you use [opencode](https://github.com/sst/opencode), you don't need this proxy — it supports Copilot natively.
