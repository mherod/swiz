/**
 * Test preload (bunfig.toml `[test] preload`).
 *
 * `bun test` fires no process exit handlers, and a file's own `afterAll` runs before later files
 * in the same process. An `afterAll` registered here runs once, after the process's last file,
 * which is the only point where removing the shared sandbox HOME is safe (#924).
 *
 * The git client is loaded here so it binds the real `Bun.spawn` before any test can replace the
 * global. Several modules reach it through a lazy `import()`; loaded for the first time inside a
 * test that has mocked `Bun.spawn`, it would keep that mock for the rest of the file and every
 * git query would fail, which silently switches off guards that depend on the origin slug.
 */
import "../git/client.ts"
import { afterAll } from "bun:test"
import { removeTestSandboxHome } from "./test-sandbox-home.ts"

afterAll(removeTestSandboxHome)
