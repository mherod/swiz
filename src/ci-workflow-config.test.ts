import { describe, expect, it } from "bun:test"
import { join } from "node:path"

describe("CI workflow events", () => {
  it("runs PR validation only from the pull_request event", async () => {
    const workflow = await Bun.file(join(import.meta.dir, "../.github/workflows/ci.yml")).text()

    expect(workflow).toMatch(/^ {2}pull_request:$/m)
    expect(workflow).not.toMatch(/^ {2}pull_request_target:$/m)
  })
})
