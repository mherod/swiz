import { describe, expect, it } from "bun:test"
import { extractAssistantText, spawnSpeak } from "../src/speech.ts"

const NO_VOICE: { narratorVoice: string; narratorSpeed: number } = {
  narratorVoice: "",
  narratorSpeed: 0,
}

describe("extractAssistantText", () => {
  it("extracts assistant text from Claude transcript entries", () => {
    expect(
      extractAssistantText({
        type: "assistant",
        message: {
          content: [
            { type: "thinking", text: "private reasoning" },
            { type: "text", text: "Claude can narrate this reply." },
          ],
        },
      })
    ).toEqual(["Claude can narrate this reply."])
  })

  it("extracts assistant output text from Codex response items", () => {
    expect(
      extractAssistantText({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Codex can narrate this reply." }],
        },
      })
    ).toEqual(["Codex can narrate this reply."])
  })

  it("does not narrate Codex user messages or tool calls", () => {
    expect(
      extractAssistantText({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Do not read my prompt aloud." }],
        },
      })
    ).toEqual([])

    expect(
      extractAssistantText({
        type: "response_item",
        payload: {
          type: "function_call",
        },
      })
    ).toEqual([])
  })
})

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
