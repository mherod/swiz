import { describe, expect, test } from "bun:test"
import { checkCodexMemory } from "./codex-memory.ts"

describe("Codex memory ownership diagnostic", () => {
  test("reports enabled native memory with supported future-session remediation", async () => {
    const result = await checkCodexMemory(
      async () => "memories stable true\nexternal_agent_memory_import under development false\n"
    )
    expect(result.status).toBe("warn")
    expect(result.detail).toContain("codex features disable memories")
    expect(result.detail).toContain("fresh session")
    expect(result.detail).toContain("does not migrate or delete")
  })
  test("does not claim disabled features changed an existing conversation", async () => {
    const result = await checkCodexMemory(async () => "memories stable false\n")
    expect(result.status).toBe("pass")
    expect(result.detail).toContain("existing conversations retain")
  })
  test("reports unrecognized feature output as unknown", async () => {
    expect((await checkCodexMemory(async () => "other_feature stable false")).status).toBe("warn")
  })
  test("reports failed inspection without exposing command stderr", async () => {
    const result = await checkCodexMemory(async () => {
      throw new Error("private host details")
    })
    expect(result.status).toBe("warn")
    expect(result.detail).not.toContain("private host details")
  })
  test("handles an absent Codex installation", async () => {
    expect((await checkCodexMemory(async () => null)).detail).toBe("Codex is not installed")
  })
})
