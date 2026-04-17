import consola from "consola"
import fs from "node:fs/promises"

import { PATHS } from "~/lib/paths"
import { getCopilotToken } from "~/services/github/get-copilot-token"
import { getDeviceCode } from "~/services/github/get-device-code"
import { getGitHubUser } from "~/services/github/get-user"
import { pollAccessToken } from "~/services/github/poll-access-token"

import { HTTPError } from "./error"
import { state } from "./state"

const MAX_RETRIES = 30
const RETRY_DELAY_MS = 2000

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  retries = MAX_RETRIES,
): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (attempt === retries) throw error
      const delay = RETRY_DELAY_MS
      consola.warn(
        `${label} failed (attempt ${attempt}/${retries}), retrying in ${delay}ms...`,
      )
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw new Error("Unreachable")
}

const readGithubToken = () => fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")

const writeGithubToken = (token: string) =>
  fs.writeFile(PATHS.GITHUB_TOKEN_PATH, token)

export const setupCopilotToken = async () => {
  const tokenResponse = await withRetry(
    () => getCopilotToken(),
    "Initial Copilot token fetch",
  )
  state.copilotToken = tokenResponse.token
  applyAccountTypeFromToken(tokenResponse)

  consola.debug("GitHub Copilot Token fetched successfully!")
  if (state.showToken) {
    consola.info("Copilot token:", tokenResponse.token)
  }

  const refreshInterval = (tokenResponse.refresh_in - 60) * 1000
  setInterval(async () => {
    consola.debug("Refreshing Copilot token")
    try {
      const refreshed = await withRetry(
        () => getCopilotToken(),
        "Copilot token refresh",
      )
      state.copilotToken = refreshed.token
      applyAccountTypeFromToken(refreshed)
      consola.debug("Copilot token refreshed")
      if (state.showToken) {
        consola.info("Refreshed Copilot token:", refreshed.token)
      }
    } catch (error) {
      consola.error("Failed to refresh Copilot token after retries:", error)
    }
  }, refreshInterval)
}

function applyAccountTypeFromToken(token: {
  endpoints?: { api?: string }
  sku?: string
}) {
  if (!state.accountTypeAuto) return

  const detected = detectAccountType(token)
  if (detected && detected !== state.accountType) {
    consola.info(
      `Auto-detected account type: ${detected}${token.sku ? ` (sku=${token.sku})` : ""}`,
    )
    state.accountType = detected
  }
}

function detectAccountType(token: {
  endpoints?: { api?: string }
  sku?: string
}): string | undefined {
  const api = token.endpoints?.api
  if (api) {
    try {
      const host = new URL(api).hostname
      const match = /^api\.(.+)\.githubcopilot\.com$/.exec(host)
      if (match) return match[1]
      if (host === "api.githubcopilot.com") return "individual"
    } catch {
      /* ignore invalid URL */
    }
  }
  const sku = token.sku?.toLowerCase() ?? ""
  if (sku.includes("enterprise")) return "enterprise"
  if (sku.includes("business")) return "business"
  if (sku) return "individual"
  return undefined
}

interface SetupGitHubTokenOptions {
  force?: boolean
}

export async function setupGitHubToken(
  options?: SetupGitHubTokenOptions,
): Promise<void> {
  try {
    const githubToken = await withRetry(
      () => readGithubToken(),
      "Read GitHub token",
    ).catch(() => null)

    if (githubToken && !options?.force) {
      state.githubToken = githubToken
      if (state.showToken) {
        consola.info("GitHub token:", githubToken)
      }
      await withRetry(() => logUser(), "Fetch GitHub user")

      return
    }

    consola.info("Not logged in, getting new access token")
    const response = await getDeviceCode()
    consola.debug("Device code response:", response)

    consola.info(
      `Please enter the code "${response.user_code}" in ${response.verification_uri}`,
    )

    const token = await pollAccessToken(response)
    await writeGithubToken(token)
    state.githubToken = token

    if (state.showToken) {
      consola.info("GitHub token:", token)
    }
    await withRetry(() => logUser(), "Fetch GitHub user")
  } catch (error) {
    if (error instanceof HTTPError) {
      consola.error("Failed to get GitHub token:", await error.response.json())
      throw error
    }

    consola.error("Failed to get GitHub token:", error)
    throw error
  }
}

async function logUser() {
  const user = await getGitHubUser()
  consola.info(`Logged in as ${user.login}`)
}
