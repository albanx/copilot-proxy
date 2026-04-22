# Copilot API Proxy

> [!WARNING]
> Reverse-engineered proxy of the GitHub Copilot API. Not supported by GitHub and may break unexpectedly. Excessive automated use may trigger GitHub's abuse detection and risk your Copilot access. Use responsibly.
>
> See: [GitHub Acceptable Use Policies](https://docs.github.com/site-policy/acceptable-use-policies/github-acceptable-use-policies) · [GitHub Copilot Terms](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot)

A local proxy that exposes GitHub Copilot as **OpenAI-compatible** (`/v1/chat/completions`, `/v1/models`, `/v1/embeddings`) and **Anthropic-compatible** (`/v1/messages`, `/v1/messages/count_tokens`) endpoints. Use Copilot as a backend for any tool that speaks either API — including [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview).

## Prerequisites

- [Bun](https://bun.sh) >= 1.2.x
- GitHub account with Copilot subscription (individual, business, or enterprise)

## Quick start (npx)

The fastest way to run the proxy — no clone required:

```sh
npx @albanx83/cpx@latest start
```

On first run you'll be prompted to authenticate with GitHub via device-code flow. The server then listens on `http://localhost:4141`.

Useful flags:

```sh
npx @albanx83/cpx start --port 8080                  # custom port
npx @albanx83/cpx start --account-type business      # force business / enterprise (default: auto-detect)
npx @albanx83/cpx start --rate-limit 30 --wait       # throttle requests
npx @albanx83/cpx start --manual                     # approve each request
npx @albanx83/cpx start --github-token ghp_...       # non-interactive auth
npx @albanx83/cpx auth                               # only mint a GitHub token
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

Or use the interactive helper, which prompts for models and copies the full launch command to your clipboard:

```sh
npx @albanx83/cpx start --claude-code
```

## CLI options (`start`)

| Option           | Description                                                    | Default      | Alias |
| ---------------- | -------------------------------------------------------------- | ------------ | ----- |
| `--port`         | Port to listen on                                              | `4141`       | `-p`  |
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

## Tips

- Use `--rate-limit <seconds>` (optionally with `--wait`) to avoid tripping Copilot's abuse detection.
- Account type is auto-detected by default. To force a specific plan, pass `--account-type individual|business|enterprise`. See [GitHub's network routing docs](https://docs.github.com/en/enterprise-cloud@latest/copilot/managing-copilot/managing-github-copilot-in-your-organization/managing-access-to-github-copilot-in-your-organization/managing-github-copilot-access-to-your-organizations-network).
- If you use [opencode](https://github.com/sst/opencode), you don't need this proxy — it supports Copilot natively.
