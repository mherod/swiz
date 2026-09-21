import { describe, expect, test } from "bun:test"
import { mkdir, rmdir } from "node:fs/promises"
import { join } from "node:path"
import { useTempDir } from "../utils/test-utils.ts"
import { readTaskStoreMeta, type SessionMeta } from "./task-repository.ts"
import { projectStoreKey } from "./task-store-path.ts"

const temp = useTempDir("swiz-meta-cache-")
const META = ".session-meta.json"

describe("session metadata negative caching", () => {
  test("a transient read failure is not cached, so the store reappears once readable", async () => {
    const root = await temp.create()
    const key = projectStoreKey("/Users/example/transient")
    const dir = join(root, key.key)
    // A directory where the meta file belongs fails with EISDIR, standing in for
    // the conflicted-store and permission failures seen in the wild.
    await mkdir(join(dir, META), { recursive: true })

    expect(await readTaskStoreMeta(key, root)).toBeNull()

    await rmdir(join(dir, META))
    const meta: SessionMeta = {
      storeKind: "session",
      openCount: 2,
      updatedAt: "2026-09-18T00:00:00.000Z",
    }
    await Bun.write(join(dir, META), JSON.stringify(meta))

    // The point of the fix: the first failure must not have poisoned the cache.
    // When it did, every later project queue in that process silently dropped
    // this store, because a missing owner reads as "belongs to another project".
    expect(await readTaskStoreMeta(key, root)).toEqual(meta)
  })

  test("control: a genuinely absent meta file is still cached as null", async () => {
    const root = await temp.create()
    const key = projectStoreKey("/Users/example/absent")
    await mkdir(join(root, key.key), { recursive: true })

    expect(await readTaskStoreMeta(key, root)).toBeNull()

    await Bun.write(
      join(root, key.key, META),
      JSON.stringify({ storeKind: "session", openCount: 1, updatedAt: "2026-09-18T00:00:00.000Z" })
    )

    // Proves the ENOENT branch really does cache: without this control the test
    // above would pass even if caching had been removed altogether.
    expect(await readTaskStoreMeta(key, root)).toBeNull()
  })
})
