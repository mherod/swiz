import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

describe("Vitest runtime", () => {
  it("executes test workers under Bun with module-local metadata", () => {
    expect(process.versions.bun).toBeDefined()
    expect(import.meta.path).toBe(fileURLToPath(import.meta.url))
    expect(import.meta.dir).toBe(dirname(fileURLToPath(import.meta.url)))
  })
})
