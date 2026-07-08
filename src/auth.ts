#!/usr/bin/env node

import { defineCommand } from "citty"

import { runServer } from "./start"

interface RunAuthOptions {
  verbose: boolean
  showToken: boolean
}

async function runAuth(options: RunAuthOptions): Promise<void> {
  // Force a fresh GitHub login, then boot the server exactly like `start` does
  // (fetch Copilot token + models, then serve). Non-auth options use `start`'s
  // defaults; `auth` intentionally exposes only `verbose` and `show-token`.
  await runServer({
    port: 4141,
    verbose: options.verbose,
    accountType: "auto",
    manual: false,
    rateLimit: undefined,
    rateLimitWait: false,
    githubToken: undefined,
    claudeCode: false,
    showToken: options.showToken,
    proxyEnv: false,
    forceGitHubAuth: true,
  })
}

export const auth = defineCommand({
  meta: {
    name: "auth",
    description:
      "Run GitHub auth flow (forced re-login), then fetch models and start the server",
  },
  args: {
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    "show-token": {
      type: "boolean",
      default: false,
      description: "Show GitHub token on auth",
    },
  },
  run({ args }) {
    return runAuth({
      verbose: args.verbose,
      showToken: args["show-token"],
    })
  },
})
