import { describe, expect, it } from "bun:test"
import { join } from "node:path"
import { resolveTaskFilePath } from "./task-file-path.ts"

const DIR = "/tmp/swiz-store"

describe("resolveTaskFilePath", () => {
  it("resolves a normal task id inside the store", () => {
    expect(resolveTaskFilePath(DIR, "349d-243")).toBe(join(DIR, "349d-243.json"))
  })

  it("rejects ids that traverse out of the store", () => {
    expect(resolveTaskFilePath(DIR, "../settings")).toBeNull()
    expect(resolveTaskFilePath(DIR, "../../.claude/settings")).toBeNull()
    expect(resolveTaskFilePath(DIR, "..")).toBeNull()
  })

  it("rejects ids carrying a path separator even without traversal", () => {
    expect(resolveTaskFilePath(DIR, "nested/task")).toBeNull()
    expect(resolveTaskFilePath(DIR, "nested\\task")).toBeNull()
  })

  it("rejects an absolute id", () => {
    expect(resolveTaskFilePath(DIR, "/etc/passwd")).toBeNull()
  })

  it("rejects empty, dot, and NUL-bearing ids", () => {
    expect(resolveTaskFilePath(DIR, "")).toBeNull()
    expect(resolveTaskFilePath(DIR, ".")).toBeNull()
    expect(resolveTaskFilePath(DIR, "task\0.json")).toBeNull()
  })

  it("allows a leading dot that does not escape", () => {
    // Control: the guard rejects traversal, not every unusual-looking id.
    expect(resolveTaskFilePath(DIR, ".hidden-task")).toBe(join(DIR, ".hidden-task.json"))
  })
})
