import consola from "consola"

import { getModels } from "~/services/copilot/get-models"
import { getVSCodeVersion } from "~/services/get-vscode-version"

import { state } from "./state"

export const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export const isNullish = (value: unknown): value is null | undefined =>
  value === null || value === undefined

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const getUserIdJsonField = (
  userIdPayload: Record<string, unknown> | null,
  field: string,
): string | null => {
  const value = userIdPayload?.[field]
  return typeof value === "string" && value.length > 0 ? value : null
}

const parseJsonUserId = (userId: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(userId)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Extract a stable safety identifier and session id from an Anthropic
 * `metadata.user_id`. Claude Code encodes these either in a legacy
 * `user_<id>_account__session_<sid>` string or as a JSON blob with
 * `device_id`/`account_uuid` and `session_id` fields. Both return `null` when
 * the field is absent or unparseable — callers use the pair to detect that a
 * request originated from a Claude-Code-style client (and only then apply the
 * messages-proxy header rewrite).
 */
export const parseUserIdMetadata = (
  userId: string | undefined,
): { safetyIdentifier: string | null; sessionId: string | null } => {
  if (!userId || typeof userId !== "string") {
    return { safetyIdentifier: null, sessionId: null }
  }

  const legacySafetyIdentifier =
    userId.match(/user_([^_]+)_account/)?.[1] ?? null
  const legacySessionId = userId.match(/_session_(.+)$/)?.[1] ?? null

  const parsedUserId =
    legacySafetyIdentifier && legacySessionId ? null : parseJsonUserId(userId)

  const safetyIdentifier =
    legacySafetyIdentifier
    ?? getUserIdJsonField(parsedUserId, "device_id")
    ?? getUserIdJsonField(parsedUserId, "account_uuid")
  const sessionId =
    legacySessionId ?? getUserIdJsonField(parsedUserId, "session_id")

  return { safetyIdentifier, sessionId }
}

// Periodically refresh models so long-running daemons pick up new SKUs without
// needing a restart. The loop self-reschedules with jitter; call
// `stopModelsRefreshLoop` to clear the pending timer for a clean shutdown.
const MODELS_REFRESH_BASE_MS = 30 * 60 * 1000

type ModelsFetcher = typeof getModels

let modelsRefreshTimer: ReturnType<typeof setTimeout> | null = null

export function stopModelsRefreshLoop(): void {
  if (modelsRefreshTimer) {
    clearTimeout(modelsRefreshTimer)
    modelsRefreshTimer = null
  }
}

/**
 * Fetch the model list and store it in `state.models`, keeping only
 * picker-enabled models plus embeddings (mirrors the upstream refresh filter).
 * Logs how many SKUs are newly visible since the previous cache.
 */
export async function refreshModels(fetcher: ModelsFetcher): Promise<void> {
  const previousIds = new Set(state.models?.data.map((model) => model.id) ?? [])

  const response = await fetcher()
  const data = response.data.filter(
    (model) =>
      model.model_picker_enabled || model.capabilities.type === "embeddings",
  )
  state.models = { ...response, data }

  const added = data.filter((model) => !previousIds.has(model.id))
  if (added.length > 0) {
    consola.info(`Models refresh: ${added.length} new`)
  } else {
    consola.debug(`Models refresh: no changes (${data.length} total)`)
  }
}

function scheduleModelsRefresh(
  fetcher: ModelsFetcher,
  intervalMs: number,
): void {
  // Spread refreshes across daemons so they don't all hit upstream at once.
  const jitter = Math.floor(Math.random() * (intervalMs / 6))
  const delay = intervalMs + jitter
  consola.debug(`Next models refresh in ${Math.round(delay / 1000)}s`)

  stopModelsRefreshLoop()
  modelsRefreshTimer = setTimeout(() => {
    void refreshModels(fetcher)
      .catch((error: unknown) => {
        consola.warn("Failed to refresh models, keeping previous cache.", error)
      })
      .finally(() => {
        scheduleModelsRefresh(fetcher, intervalMs)
      })
  }, delay)
}

export async function cacheModels(
  fetcher: ModelsFetcher = getModels,
  intervalMs: number = MODELS_REFRESH_BASE_MS,
): Promise<void> {
  await refreshModels(fetcher)
  scheduleModelsRefresh(fetcher, intervalMs)
}

export const cacheVSCodeVersion = async () => {
  const response = await getVSCodeVersion()
  state.vsCodeVersion = response

  consola.info(`Using VSCode version: ${response}`)
}
