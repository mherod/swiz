/**
 * Test preload (bunfig.toml `[test] preload`).
 *
 * `bun test` fires no process exit handlers, and a file's own `afterAll` runs before later files
 * in the same process. An `afterAll` registered here runs once, after the process's last file,
 * which is the only point where removing the shared sandbox HOME is safe (#924).
 */
import { afterAll } from "bun:test"
import { removeTestSandboxHome } from "./test-sandbox-home.ts"

afterAll(removeTestSandboxHome)
