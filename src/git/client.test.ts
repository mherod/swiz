import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync } from "node:fs"
import { join } from "node:path"
import { git } from "../git-helpers.ts"
import { useTempDir } from "../utils/test-utils.ts"
import { BunGitClient, getGitClient, withGitClient, withGitClientSync } from "./client.ts"
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

describe("BunGitClient environment", () => {
  const temporary = useTempDir("swiz-git-client-")
  const client = new BunGitClient()
  const savedEnvironment = Object.fromEntries(
    ["GIT_EXEC_PATH", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"].map((key) => [
      key,
      process.env[key],
    ])
  )

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  async function createHelper(): Promise<string> {
    const directory = await temporary.create()
    const helperPath = join(directory, "git-swiz-helper-probe")
    await Bun.write(helperPath, '#!/bin/sh\nprintf "%s\\n" "$SWIZ_GIT_TEST_VALUE"\n')
    chmodSync(helperPath, 0o755)
    return directory
  }

  for (const method of ["run", "runSync"] as const) {
    describe(method, () => {
      test("discovers helpers through inherited GIT_EXEC_PATH", async () => {
        const directory = await createHelper()
        process.env.GIT_EXEC_PATH = directory
        const withoutHelperPath = await client[method](["swiz-helper-probe"], {
          cwd: directory,
          env: { GIT_EXEC_PATH: undefined },
        })
        expect(withoutHelperPath.exitCode).not.toBe(0)
        expect(withoutHelperPath.stderr).toContain("not a git command")

        const result = await client[method](["swiz-helper-probe"], {
          cwd: directory,
          env: { SWIZ_GIT_TEST_VALUE: "inherited-helper" },
        })

        expect(result).toEqual({ stdout: "inherited-helper\n", stderr: "", exitCode: 0 })
      })

      test("uses an explicit helper path over the inherited path", async () => {
        const directory = await createHelper()
        process.env.GIT_EXEC_PATH = join(directory, "missing")

        const result = await client[method](["swiz-helper-probe"], {
          cwd: directory,
          env: { GIT_EXEC_PATH: directory, SWIZ_GIT_TEST_VALUE: "override-helper" },
        })

        expect(result).toEqual({ stdout: "override-helper\n", stderr: "", exitCode: 0 })
      })

      test.each([undefined, ""])("uses normal helper discovery for %p", async (value) => {
        const directory = await temporary.create()
        process.env.GIT_EXEC_PATH = join(directory, "missing")
        const baseline = await client[method](["--exec-path"], {
          cwd: directory,
          env: { GIT_EXEC_PATH: undefined },
        })
        const result = await client[method](["--exec-path"], {
          cwd: directory,
          env: { GIT_EXEC_PATH: value },
        })

        expect(baseline.exitCode).toBe(0)
        expect(baseline.stdout.trim()).not.toBe("")
        expect(baseline.stdout.trim()).not.toBe(process.env.GIT_EXEC_PATH)
        expect(result).toEqual(baseline)
      })

      test.each([
        "inherited",
        "overrides",
      ])("isolates the repository and index from %s Git variables", async (source) => {
        const directory = await temporary.create()
        const other = await temporary.create()
        const env = { HOME: directory, XDG_CONFIG_HOME: directory }
        for (const cwd of [directory, other]) {
          expect(client.runSync(["init", "--template="], { cwd, env }).exitCode).toBe(0)
        }
        await Bun.write(join(directory, "tracked.txt"), "requested repository\n")
        expect(client.runSync(["add", "tracked.txt"], { cwd: directory, env }).exitCode).toBe(0)
        const expectedRoot = client.runSync(["rev-parse", "--show-toplevel"], {
          cwd: directory,
          env,
        })
        const indexPath = join(other, "invalid-index")
        await Bun.write(indexPath, "not a Git index")
        const contamination = {
          GIT_DIR: join(other, ".git"),
          GIT_WORK_TREE: other,
          GIT_INDEX_FILE: indexPath,
        }
        if (source === "inherited") Object.assign(process.env, contamination)
        const options = {
          cwd: directory,
          env: { ...env, ...(source === "overrides" ? contamination : {}) },
        }

        expect(await client[method](["rev-parse", "--show-toplevel"], options)).toEqual(
          expectedRoot
        )
        expect(await client[method](["ls-files"], options)).toEqual({
          stdout: "tracked.txt\n",
          stderr: "",
          exitCode: 0,
        })
        expect(await Bun.file(indexPath).text()).toBe("not a Git index")
      })
    })
  }
})
