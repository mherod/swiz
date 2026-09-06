import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { TMP_ROOT } from "../../../temp-paths.ts"
import {
  BaseFileWatcherRegistry,
  type FileWatcherRuntime,
  type WatchRegistrationOptions,
} from "./file-watcher-registry.ts"

/**
 * The daemon registers `<cwd>/.git/` so a branch, ref or index change evicts that project's warm
 * status snapshot. The registry's ignore rules matched the path and dropped the registration
 * without a word, so warm snapshots stayed stale for a whole 20-second bucket (#807).
 *
 * These cases go through the real `register` boundary and an actual watcher event, because a
 * test that calls the invalidation callback directly passes just as happily when nothing is
 * registered at all.
 */

interface Harness {
  registry: BaseFileWatcherRegistry
  /** Fire a watcher event for `path`, then drain the debounce. */
  emit: (path: string, filename?: string) => void
  watched: string[]
}

function createHarness(): Harness {
  const listeners = new Map<string, (event: string, filename: string | null) => void>()
  const scheduled: Array<() => void> = []
  const watched: string[] = []

  const runtime: FileWatcherRuntime = {
    watch: (path, _options, listener) => {
      watched.push(path)
      listeners.set(path, listener)
      return { close: () => listeners.delete(path) }
    },
    schedule: (callback) => {
      scheduled.push(callback)
      return scheduled.length - 1
    },
    cancel: () => {},
    now: () => 1_000,
  }

  return {
    registry: new BaseFileWatcherRegistry(runtime),
    watched,
    emit: (path, filename = "HEAD") => {
      listeners.get(path)?.("change", filename)
      // Debounced flush is scheduled, not immediate; drain it deterministically.
      while (scheduled.length > 0) scheduled.shift()?.()
    },
  }
}

const projectGitDir = (name: string) => join(TMP_ROOT, `swiz-git-watch-${name}`, ".git/")

describe("explicit git watcher registration", () => {
  test("is dropped without the opt-in, which is the defect", async () => {
    // Control for the case below: without the flag nothing registers, so an assertion that the
    // callback fired would be vacuous rather than meaningful.
    const { registry } = createHarness()
    let fired = 0
    registry.register(projectGitDir("control"), "git:control", () => fired++)
    await registry.start()

    expect(registry.status()).toHaveLength(0)
    expect(fired).toBe(0)
  })

  test("reaches the registry and starts a watcher with the opt-in", async () => {
    const { registry, watched } = createHarness()
    const path = projectGitDir("allowed")
    registry.register(path, "git:allowed", () => {}, { allowIgnoredPath: true })
    await registry.start()

    const status = registry.status()
    expect(status).toHaveLength(1)
    expect(status[0]?.path).toBe(path)
    expect(status[0]?.watching).toBe(true)
    expect(watched).toContain(path)
  })

  test("invalidates the owning project when a ref changes", async () => {
    const { registry, emit } = createHarness()
    const path = projectGitDir("owner")
    let fired = 0
    registry.register(path, "git:owner", () => fired++, { allowIgnoredPath: true })
    await registry.start()

    emit(path, "refs/heads/main")
    expect(fired).toBe(1)

    emit(path, "index")
    expect(fired).toBe(2)
  })

  test("does not invalidate a sibling project", async () => {
    const { registry, emit } = createHarness()
    const owner = projectGitDir("sibling-a")
    const sibling = projectGitDir("sibling-b")
    let ownerFired = 0
    let siblingFired = 0
    registry.register(owner, "git:a", () => ownerFired++, { allowIgnoredPath: true })
    registry.register(sibling, "git:b", () => siblingFired++, { allowIgnoredPath: true })
    await registry.start()

    emit(owner, "refs/heads/main")

    expect(ownerFired).toBe(1)
    expect(siblingFired).toBe(0)
  })

  test("delivers events whose relative path would otherwise be ignored", async () => {
    // `.git/modules/<sub>/HEAD` contains a segment the generic filter rejects. The explicit
    // entry opted past the rules at registration, so re-applying them per event would silently
    // drop exactly the changes it was registered for.
    const { registry, emit } = createHarness()
    const path = projectGitDir("submodule")
    let fired = 0
    registry.register(path, "git:submodule", () => fired++, { allowIgnoredPath: true })
    await registry.start()

    emit(path, "modules/vendor/.git/HEAD")
    expect(fired).toBe(1)
  })

  test("keeps ignoring git internals inside a generic recursive source watch", async () => {
    // The opt-in must stay scoped to explicitly named paths; ordinary tree watches should not
    // start firing on every object write.
    const { registry, emit } = createHarness()
    const root = join(TMP_ROOT, "swiz-git-watch-source", "/")
    let fired = 0
    registry.register(root, "source", () => fired++)
    await registry.start()

    emit(root, ".git/objects/ab/cdef")
    expect(fired).toBe(0)

    // Control: a real source change through the same watcher still fires.
    emit(root, "src/index.ts")
    expect(fired).toBe(1)
  })

  test("closes the explicit watcher on unregister", async () => {
    const { registry, emit } = createHarness()
    const path = projectGitDir("evicted")
    let fired = 0
    registry.register(path, "git:evicted", () => fired++, { allowIgnoredPath: true })
    await registry.start()

    expect(registry.unregisterByLabelSuffix(":evicted")).toBe(1)
    expect(registry.status()).toHaveLength(0)

    // Callback state is gone, so a late event cannot resurrect it.
    emit(path, "refs/heads/main")
    expect(fired).toBe(0)
  })

  test("shares one options type across every registration facade", () => {
    // The worker message and worker proxy both take this shape; keeping it single-sourced is
    // what stops the flag being accepted on the main thread and dropped in transport.
    const options: WatchRegistrationOptions = {
      recursive: true,
      depth: 0,
      allowIgnoredPath: true,
    }
    expect(options.allowIgnoredPath).toBe(true)
  })
})
