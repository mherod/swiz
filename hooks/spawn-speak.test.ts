import { describe, expect, it } from "bun:test"
import { spawnSpeak } from "./utils/hook-utils.ts"

const NO_VOICE: { narratorVoice: string; narratorSpeed: number } = {
  narratorVoice: "",
  narratorSpeed: 0,
}

describe("spawnSpeak", () => {
  it("resolves silently when given a nonexistent script path", async () => {
    // spawnSpeak must swallow errors so hook failures never propagate to callers
    const result = await spawnSpeak("hello", NO_VOICE, "/nonexistent/path/to/speak.ts")
    expect(result).toBeUndefined()
  })

  it("resolves silently with voice and speed settings and invalid path", async () => {
    const settings = { narratorVoice: "Samantha", narratorSpeed: 200 }
    const result = await spawnSpeak("hello", settings, "/nonexistent/speak.ts")
    expect(result).toBeUndefined()
  })

  it("resolves silently with empty text", async () => {
    const result = await spawnSpeak("", NO_VOICE, "/nonexistent/speak.ts")
    expect(result).toBeUndefined()
  })

  it("resolves silently when narratorSpeed is 0 (uses system default)", async () => {
    const settings = { narratorVoice: "Alex", narratorSpeed: 0 }
    const result = await spawnSpeak("test", settings, "/nonexistent/speak.ts")
    expect(result).toBeUndefined()
  })

  it("resolves silently when narratorVoice is empty (uses system default)", async () => {
    const settings = { narratorVoice: "", narratorSpeed: 150 }
    const result = await spawnSpeak("test", settings, "/nonexistent/speak.ts")
    expect(result).toBeUndefined()
  })

  it("uses default speak.ts path (hooks directory) when no path given", async () => {
    // With speak disabled (no real audio in CI), the real speak.ts will exit non-zero
    // but spawnSpeak must still resolve without throwing
    const result = await spawnSpeak("test", NO_VOICE)
    expect(result).toBeUndefined()
  }, 30000)
})
