import { describe, expect, test } from "bun:test"

import { server } from "../src/server"

/**
 * The proxy has no inbound authentication, so a wildcard CORS policy would let
 * any site the user visits spend their Copilot quota from the browser and read
 * the replies. Preflight a JSON POST the way a browser would and assert only
 * loopback origins are approved.
 */
const preflightOrigin = async (origin?: string): Promise<string | null> => {
  const response = await server.request("/v1/messages", {
    method: "OPTIONS",
    headers: {
      ...(origin ? { Origin: origin } : {}),
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  })

  return response.headers.get("access-control-allow-origin")
}

describe("CORS policy", () => {
  test("refuses a cross-site origin so a web page cannot spend the user's quota", async () => {
    expect(await preflightOrigin("https://evil.com")).toBeNull()
  })

  test("never answers with a wildcard origin", async () => {
    expect(await preflightOrigin("https://evil.com")).not.toBe("*")
    expect(await preflightOrigin("http://localhost:3000")).not.toBe("*")
  })

  test("allows loopback origins so local web UIs keep working", async () => {
    expect(await preflightOrigin("http://localhost:3000")).toBe(
      "http://localhost:3000",
    )
    expect(await preflightOrigin("http://127.0.0.1:8080")).toBe(
      "http://127.0.0.1:8080",
    )
  })

  test("ignores a malformed Origin header instead of echoing it back", async () => {
    expect(await preflightOrigin("not-a-url")).toBeNull()
  })

  test("leaves non-browser clients (no Origin) unaffected", async () => {
    const response = await server.request("/")
    expect(response.status).toBe(200)
  })
})
