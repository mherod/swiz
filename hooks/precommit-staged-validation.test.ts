import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getGitClient } from "../src/git/client.ts"
import { evaluatePrecommitStagedValidation } from "./precommit-staged-validation.ts"

describe("precommit-staged-validation repository capability", () => {
  const tempDirs: string[] = []

  afterAll(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test("trusts enriched non-repository membership without fallback", async () => {
    let fallbackCalls = 0
    const output = await evaluatePrecommitStagedValidation(
      {
        cwd: "/repo",
        _repositoryCapability: {
          canonicalRoot: "/repo",
          repoKey: "precommit-validation-test",
          isRepo: false,
          repoSlug: null,
          hasGhCli: true,
          resolvedAt: Date.now(),
        },
      },
      () => {
        fallbackCalls++
        return Promise.resolve(true)
      }
    )

    expect(output).toEqual({})
    expect(fallbackCalls).toBe(0)
  })

  test("retains the standalone non-repository fallback", async () => {
    let fallbackCalls = 0
    const output = await evaluatePrecommitStagedValidation({ cwd: "/repo" }, () => {
      fallbackCalls++
      return Promise.resolve(false)
    })

    expect(output).toEqual({})
    expect(fallbackCalls).toBe(1)
  })

  test("keeps malformed scheduled input fail-open", async () => {
    expect(await evaluatePrecommitStagedValidation(null)).toEqual({})
  })

  test("blocks a final staged snapshot containing the absolute home path", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "swiz-precommit-home-path-"))
    tempDirs.push(cwd)
    await getGitClient().run(["init", "-q"], { cwd })
    const homePath = process.env.HOME
    expect(homePath).toBeTruthy()
    await Bun.write(join(cwd, "receipt.json"), JSON.stringify({ command: `${homePath}/bin/tool` }))
    await getGitClient().run(["add", "--", "receipt.json"], { cwd })

    const output = await evaluatePrecommitStagedValidation({
      cwd,
      _repositoryCapability: {
        canonicalRoot: cwd,
        repoKey: "precommit-validation-test",
        isRepo: true,
        repoSlug: "mherod/swiz",
        hasGhCli: true,
        resolvedAt: Date.now(),
      },
    })
    const serialized = JSON.stringify(output)

    expect(serialized).toContain('"decision":"block"')
    expect(serialized).toContain("absolute home directory")
    expect(serialized).toContain("receipt.json")
  })
})
