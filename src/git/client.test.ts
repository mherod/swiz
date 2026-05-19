import { describe, expect, test } from "bun:test"
import { git } from "../git-helpers.ts"
import { getGitClient, withGitClient, withGitClientSync } from "./client.ts"
import { MockGitClient } from "./mock-client.ts"

describe("GitClient abstraction", () => {
  test("git helper reads from the active mock client", async () => {
    const client = new MockGitClient((args) => {
      if (args.join(" ") === "branch --show-current") return "feature/mock"
      return { exitCode: 1 }
    })

    const branch = await withGitClient(
      client,
      async () => await git(["branch", "--show-current"], "/repo")
    )

    expect(branch).toBe("feature/mock")
    expect(client.calls[0]).toMatchObject({
      args: ["branch", "--show-current"],
      options: { cwd: "/repo" },
    })
  })

  test("withGitClient scopes mocks to the current async context", async () => {
    const client = new MockGitClient(() => "mocked")

    const inside = await withGitClient(client, async () => getGitClient())
    const outside = getGitClient()

    expect(inside).toBe(client)
    expect(outside).not.toBe(client)
  })

  test("withGitClientSync scopes synchronous git calls", () => {
    const client = new MockGitClient(() => "abc123")

    const value = withGitClientSync(client, () =>
      getGitClient().runSync(["rev-parse", "HEAD"], { cwd: "/repo" }).stdout.trim()
    )

    expect(value).toBe("abc123")
  })
})
