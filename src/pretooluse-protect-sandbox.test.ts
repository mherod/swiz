import { describe, expect, it } from "bun:test"
import { isSandboxDisableCommand } from "../hooks/pretooluse-protect-sandbox.ts"

describe("isSandboxDisableCommand", () => {
  // ── disable subcommand ────────────────────────────────────────────────────

  it("blocks: swiz settings disable sandboxed-edits", () => {
    expect(isSandboxDisableCommand("swiz settings disable sandboxed-edits")).toBe(true)
  })

  it("blocks: swiz settings disable sandboxededits", () => {
    expect(isSandboxDisableCommand("swiz settings disable sandboxededits")).toBe(true)
  })

  it("blocks: swiz settings disable sandboxed_edits", () => {
    expect(isSandboxDisableCommand("swiz settings disable sandboxed_edits")).toBe(true)
  })

  it("blocks: swiz settings disable sandboxedEdits", () => {
    expect(isSandboxDisableCommand("swiz settings disable sandboxedEdits")).toBe(true)
  })

  // ── set … false path ──────────────────────────────────────────────────────

  it("blocks: swiz settings set sandboxed-edits false", () => {
    expect(isSandboxDisableCommand("swiz settings set sandboxed-edits false")).toBe(true)
  })

  it("blocks: swiz settings set sandboxededits false", () => {
    expect(isSandboxDisableCommand("swiz settings set sandboxededits false")).toBe(true)
  })

  it("blocks: swiz settings set sandboxed_edits false", () => {
    expect(isSandboxDisableCommand("swiz settings set sandboxed_edits false")).toBe(true)
  })

  it("blocks: swiz settings set sandboxedEdits false", () => {
    expect(isSandboxDisableCommand("swiz settings set sandboxedEdits false")).toBe(true)
  })

  // ── extra whitespace / flags ──────────────────────────────────────────────

  it("blocks command with trailing whitespace", () => {
    expect(isSandboxDisableCommand("swiz settings disable sandboxed-edits  ")).toBe(true)
  })

  it("blocks command embedded in a longer script", () => {
    expect(isSandboxDisableCommand("swiz settings disable sandboxed-edits && echo done")).toBe(true)
  })

  // ── allowed commands ──────────────────────────────────────────────────────

  it("allows: swiz settings disable other-setting", () => {
    expect(isSandboxDisableCommand("swiz settings disable other-setting")).toBe(false)
  })

  it("allows: swiz settings enable sandboxed-edits", () => {
    expect(isSandboxDisableCommand("swiz settings enable sandboxed-edits")).toBe(false)
  })

  it("allows: swiz settings set sandboxed-edits true", () => {
    expect(isSandboxDisableCommand("swiz settings set sandboxed-edits true")).toBe(false)
  })

  it("allows: unrelated bash command", () => {
    expect(isSandboxDisableCommand("git status")).toBe(false)
  })

  it("allows: empty string", () => {
    expect(isSandboxDisableCommand("")).toBe(false)
  })
})
