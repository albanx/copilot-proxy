import { describe, expect, test } from "bun:test"

import { copilotHeaders, githubHeaders } from "../src/lib/api-config"
import { type State } from "../src/lib/state"

const mkState = (): State =>
  ({
    githubToken: "gh_token",
    copilotToken: "copilot_token",
    accountType: "individual",
    vsCodeVersion: "1.2.3",
  }) as unknown as State

describe("api version headers", () => {
  test("sends the bumped inference version to the Copilot API", () => {
    const headers = copilotHeaders(mkState())
    expect(headers["x-github-api-version"]).toBe("2026-06-01")
  })

  test("keeps the GitHub REST / token-exchange path on the known-good version", () => {
    const headers = githubHeaders(mkState())
    expect(headers["x-github-api-version"]).toBe("2025-04-01")
  })
})
