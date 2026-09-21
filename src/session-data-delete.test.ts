/**
 * `defaultTrashPath` must report failure rather than throw when the `trash` CLI
 * is unavailable. Callers count a false return and advise installing it; an
 * escaping ENOENT instead aborts the whole cleanup run (see cleanup.ts's
 * "could not be trashed — is the `trash` CLI installed?" notice).
 */

import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultTrashPath } from "./session-data-delete.ts"

describe("defaultTrashPath", () => {
  test("returns false instead of throwing when the trash CLI is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-trash-missing-"))
    const target = join(dir, "victim.txt")
    await Bun.write(target, "contents")

    expect(await defaultTrashPath(target, join(dir, "no-such-trash-binary"))).toBe(false)
    // A failed trash must leave the file intact rather than half-deleting it.
    expect(await Bun.file(target).exists()).toBe(true)
  })

  test("returns false when the trash CLI exits non-zero", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-trash-failing-"))
    const target = join(dir, "victim.txt")
    await Bun.write(target, "contents")

    const failing = join(dir, "failing-trash")
    await Bun.write(failing, "#!/bin/sh\nexit 3\n")
    await Bun.spawn(["chmod", "+x", failing]).exited

    expect(await defaultTrashPath(target, failing)).toBe(false)
    expect(await Bun.file(target).exists()).toBe(true)
  })

  test("reports success when the trash CLI removes the path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-trash-present-"))
    const target = join(dir, "victim.txt")
    await Bun.write(target, "contents")

    const working = join(dir, "working-trash")
    await Bun.write(working, '#!/bin/sh\nrm -rf "$@"\n')
    await Bun.spawn(["chmod", "+x", working]).exited

    expect(await defaultTrashPath(target, working)).toBe(true)
    expect(await Bun.file(target).exists()).toBe(false)
  })
})
