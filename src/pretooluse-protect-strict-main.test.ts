import { describe, expect, it } from "bun:test"
import { isStrictMainDisableCommand } from "../hooks/pretooluse-protect-strict-main.ts"

describe("isStrictMainDisableCommand", () => {
  // ── disable subcommand ────────────────────────────────────────────────────

  it("blocks: swiz settings disable strict-no-direct-main", () => {
    expect(isStrictMainDisableCommand("swiz settings disable strict-no-direct-main")).toBe(true)
  })

  it("blocks: swiz settings disable strictnodirectmain", () => {
    expect(isStrictMainDisableCommand("swiz settings disable strictnodirectmain")).toBe(true)
  })

  it("blocks: swiz settings disable strict_no_direct_main", () => {
    expect(isStrictMainDisableCommand("swiz settings disable strict_no_direct_main")).toBe(true)
  })

  it("blocks: swiz settings disable strict-main", () => {
    expect(isStrictMainDisableCommand("swiz settings disable strict-main")).toBe(true)
  })

  it("blocks: swiz settings disable no-direct-main", () => {
    expect(isStrictMainDisableCommand("swiz settings disable no-direct-main")).toBe(true)
  })

  it("blocks: swiz settings disable strictNoDirectMain", () => {
    expect(isStrictMainDisableCommand("swiz settings disable strictNoDirectMain")).toBe(true)
  })

  // ── set … false path ──────────────────────────────────────────────────────

  it("blocks: swiz settings set strict-no-direct-main false", () => {
    expect(isStrictMainDisableCommand("swiz settings set strict-no-direct-main false")).toBe(true)
  })

  it("blocks: swiz settings set strictnodirectmain false", () => {
    expect(isStrictMainDisableCommand("swiz settings set strictnodirectmain false")).toBe(true)
  })

  it("blocks: swiz settings set strict_no_direct_main false", () => {
    expect(isStrictMainDisableCommand("swiz settings set strict_no_direct_main false")).toBe(true)
  })

  it("blocks: swiz settings set strict-main false", () => {
    expect(isStrictMainDisableCommand("swiz settings set strict-main false")).toBe(true)
  })

  it("blocks: swiz settings set no-direct-main false", () => {
    expect(isStrictMainDisableCommand("swiz settings set no-direct-main false")).toBe(true)
  })

  it("blocks: swiz settings set strictNoDirectMain false", () => {
    expect(isStrictMainDisableCommand("swiz settings set strictNoDirectMain false")).toBe(true)
  })

  // ── extra whitespace / flags ──────────────────────────────────────────────

  it("blocks command with trailing whitespace", () => {
    expect(isStrictMainDisableCommand("swiz settings disable strict-no-direct-main  ")).toBe(true)
  })

  it("blocks command embedded in a longer script", () => {
    expect(
      isStrictMainDisableCommand("swiz settings disable strict-no-direct-main && echo done")
    ).toBe(true)
  })

  // ── allowed commands ──────────────────────────────────────────────────────

  it("allows: swiz settings disable other-setting", () => {
    expect(isStrictMainDisableCommand("swiz settings disable other-setting")).toBe(false)
  })

  it("allows: swiz settings enable strict-no-direct-main", () => {
    expect(isStrictMainDisableCommand("swiz settings enable strict-no-direct-main")).toBe(false)
  })

  it("allows: swiz settings set strict-no-direct-main true", () => {
    expect(isStrictMainDisableCommand("swiz settings set strict-no-direct-main true")).toBe(false)
  })

  it("allows: unrelated bash command", () => {
    expect(isStrictMainDisableCommand("git status")).toBe(false)
  })

  it("allows: empty string", () => {
    expect(isStrictMainDisableCommand("")).toBe(false)
  })

  it("does not match on prefix: strict-no-direct-main-extra is not blocked", () => {
    expect(isStrictMainDisableCommand("swiz settings disable strict-no-direct-main-extra")).toBe(
      false
    )
  })
})
