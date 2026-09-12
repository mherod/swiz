import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { runCommandInProcess, useTempDir } from "../utils/test-utils.ts"
import { manageCommand } from "./manage.ts"

const tmp = useTempDir("swiz-manage-headers-")

describe("MCP header display", () => {
  test("shows custom header names with all values redacted", async () => {
    const home = await tmp.create()
    const headers = {
      Authorization: "authorization-fixture",
      "X-Api-Key": "api-key-fixture",
      "X-Custom-Credential": "custom-credential-fixture",
      Accept: "application/json",
    }
    await Bun.write(
      join(home, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: { remote: { url: "https://example.com/mcp", headers } },
      })
    )
    const result = await runCommandInProcess(manageCommand, ["mcp", "show", "remote", "--cursor"], {
      commandOptions: { home, cwd: home },
      env: { HOME: home },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("headers:")
    for (const [name, value] of Object.entries(headers)) {
      expect(result.stdout).toContain(`${name}=[redacted]`)
      expect(result.stdout).not.toContain(value)
    }
  })

  test.each([undefined, {}])("stdio output remains unchanged for headers %j", async (headers) => {
    const home = await tmp.create()
    await Bun.write(
      join(home, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          local: { command: "bun", args: ["server.ts"], env: { MODE: "test" }, headers },
        },
      })
    )
    const result = await runCommandInProcess(manageCommand, ["mcp", "show", "local", "--cursor"], {
      commandOptions: { home, cwd: home },
      env: { HOME: home },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("transport: bun\n    args: server.ts\n    env: MODE=test")
    expect(result.stdout).not.toContain("headers:")
  })
})
