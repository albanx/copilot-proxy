import { randomUUID } from "node:crypto"

import type { State } from "./state"

export const standardHeaders = () => ({
  "content-type": "application/json",
  accept: "application/json",
})

const COPILOT_VERSION = "0.26.7"
const EDITOR_PLUGIN_VERSION = `copilot-chat/${COPILOT_VERSION}`
const USER_AGENT = `GitHubCopilotChat/${COPILOT_VERSION}`
// User-agent the VS Code Copilot Chat extension sends when proxying native
// Claude Code Messages traffic. Used by prepareMessageProxyHeaders below.
const CLAUDE_AGENT_USER_AGENT =
  "vscode_claude_code/2.1.112 (external, sdk-ts, agent-sdk/0.2.112)"

const API_VERSION = "2025-04-01"

export const copilotBaseUrl = (state: State) =>
  state.accountType === "individual" ?
    "https://api.githubcopilot.com"
  : `https://api.${state.accountType}.githubcopilot.com`
export const copilotHeaders = (state: State, vision: boolean = false) => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${state.copilotToken}`,
    "content-type": standardHeaders()["content-type"],
    "copilot-integration-id": "vscode-chat",
    "editor-version": `vscode/${state.vsCodeVersion}`,
    "editor-plugin-version": EDITOR_PLUGIN_VERSION,
    "user-agent": USER_AGENT,
    "openai-intent": "conversation-panel",
    "x-github-api-version": API_VERSION,
    "x-request-id": randomUUID(),
    "x-vscode-user-agent-library-version": "electron-fetch",
  }

  if (vision) headers["copilot-vision-request"] = "true"

  return headers
}

/**
 * Rewrite an outbound header set so it matches what the VS Code Copilot Chat
 * extension sends when it proxies native Claude Code Messages traffic. Copilot's
 * upstream WAF only accepts the Anthropic passthrough when the request presents
 * this "messages-proxy" identity — a Claude-Code user-agent with a regenerated
 * request id, the messages-proxy interaction/intent, and NO
 * `copilot-integration-id` header. Applied only for requests we detect as
 * originating from a Claude-Code-style client (see createMessages).
 */
export const prepareMessageProxyHeaders = (headers: Record<string, string>) => {
  // VS Code Copilot's Claude agent regenerates the request id per request and
  // reuses the same value for the agent-task id, keeping the pair consistent.
  const requestIdValue = randomUUID()
  headers["x-agent-task-id"] = requestIdValue
  headers["x-request-id"] = requestIdValue

  headers["x-interaction-type"] = "messages-proxy"
  headers["openai-intent"] = "messages-proxy"
  headers["user-agent"] = CLAUDE_AGENT_USER_AGENT

  delete headers["copilot-integration-id"]
}

export const GITHUB_API_BASE_URL = "https://api.github.com"
export const githubHeaders = (state: State) => ({
  ...standardHeaders(),
  authorization: `token ${state.githubToken}`,
  "editor-version": `vscode/${state.vsCodeVersion}`,
  "editor-plugin-version": EDITOR_PLUGIN_VERSION,
  "user-agent": USER_AGENT,
  "x-github-api-version": API_VERSION,
  "x-vscode-user-agent-library-version": "electron-fetch",
})

export const GITHUB_BASE_URL = "https://github.com"
export const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98"
export const GITHUB_APP_SCOPES = ["read:user"].join(" ")
