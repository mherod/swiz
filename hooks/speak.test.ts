import { describe, expect, it } from "bun:test"
import { binaryExists, runSpeak, safeSpawn } from "./speak.ts"

describe("hooks/speak.ts", () => {
  describe("binaryExists", () => {
    it("returns true for existing commands on PATH", async () => {
      const exists = await binaryExists("ls")
      expect(exists).toBe(true)
    })

    it("returns false for nonexistent commands", async () => {
      const exists = await binaryExists("definitely_nonexistent_binary_xyz_123")
      expect(exists).toBe(false)
    })
  })

  describe("safeSpawn", () => {
    it("returns true for successful commands", async () => {
      const ok = await safeSpawn(["echo", "hello world"])
      expect(ok).toBe(true)
    })

    it("returns false for non-zero exit codes", async () => {
      const ok = await safeSpawn(["ls", "/nonexistent_test_dir_123456789"])
      expect(ok).toBe(false)
    })

    it("returns false and times out for hanging commands", async () => {
      const start = Date.now()
      const ok = await safeSpawn(["sleep", "5"], 100)
      const duration = Date.now() - start
      expect(ok).toBe(false)
      expect(duration).toBeLessThan(3000)
    })
  })

  describe("runSpeak", () => {
    it("handles --diagnose mode cleanly", async () => {
      const ok = await runSpeak(["--diagnose"])
      expect(ok).toBe(true)
    })

    it("returns false when no text is provided", async () => {
      const ok = await runSpeak([], "")
      expect(ok).toBe(false)
    })
  })

  describe("source compliance", () => {
    it("contains no direct Bun.spawn calls in hooks/speak.ts", async () => {
      const content = await Bun.file("hooks/speak.ts").text()
      const matches = content.match(/\bBun\.spawn\s*\(/g)
      expect(matches).toBeNull()
    })
  })
})
