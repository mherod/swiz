import { describe, expect, it } from "bun:test"
import { entryToDisplayTurn, formatToolUse, prettifyUserMessageText } from "./transcript-format.ts"

describe("prettifyUserMessageText", () => {
  it("returns undefined when no tags are present", () => {
    expect(prettifyUserMessageText("just a normal message")).toBeUndefined()
    expect(prettifyUserMessageText("contains < but no tags")).toBeUndefined()
  })

  it("suppresses lone local-command-caveat messages", () => {
    const raw = "<local-command-caveat>Caveat: do not respond</local-command-caveat>"
    expect(prettifyUserMessageText(raw)).toEqual({ text: null })
  })

  it("does not strip tags embedded inside user-typed prose", () => {
    const raw = "Heads up.\n<local-command-caveat>noise</local-command-caveat>\nMore text."
    expect(prettifyUserMessageText(raw)).toBeUndefined()
  })

  it("does not strip a single <command-name> tag embedded inside user prose", () => {
    const raw = "Look at this sample:\n<command-name>/model</command-name>\nin the output."
    expect(prettifyUserMessageText(raw)).toBeUndefined()
  })

  it("renders a slash command with no args", () => {
    const raw =
      "<command-name>/model</command-name>\n" +
      "            <command-message>model</command-message>\n" +
      "            <command-args></command-args>"
    expect(prettifyUserMessageText(raw)).toEqual({
      text: "/model",
      kind: "slash-command",
    })
  })

  it("renders a slash command with args", () => {
    const raw =
      "<command-name>/effort</command-name>" +
      "<command-message>effort</command-message>" +
      "<command-args>high</command-args>"
    expect(prettifyUserMessageText(raw)).toEqual({
      text: "/effort high",
      kind: "slash-command",
    })
  })

  it("normalizes a command-name lacking a leading slash", () => {
    const raw = "<command-name>commit</command-name>"
    expect(prettifyUserMessageText(raw)).toEqual({
      text: "/commit",
      kind: "slash-command",
    })
  })

  it("renders local-command-stdout with an output marker", () => {
    const raw =
      "<local-command-stdout>Set model to Opus 4.7 (1M context) (default)</local-command-stdout>"
    expect(prettifyUserMessageText(raw)).toEqual({
      text: "↳ Set model to Opus 4.7 (1M context) (default)",
      kind: "command-output",
    })
  })

  it("strips ANSI escapes from command stdout", () => {
    const raw = `<local-command-stdout>\x1b[31mred\x1b[0m text</local-command-stdout>`
    expect(prettifyUserMessageText(raw)).toEqual({
      text: "↳ red text",
      kind: "command-output",
    })
  })

  it("renders local-command-stderr with an error marker", () => {
    const raw = "<local-command-stderr>oops</local-command-stderr>"
    expect(prettifyUserMessageText(raw)).toEqual({
      text: "✗ oops",
      kind: "command-error",
    })
  })

  it("falls back when only an unrecognized empty stdout is present", () => {
    const raw = "<local-command-stdout>   </local-command-stdout>"
    expect(prettifyUserMessageText(raw)).toEqual({ text: null })
  })

  it("collapses a command-name skill invocation to the slash name", () => {
    const raw =
      "<command-name>re-assess</command-name>\n" +
      "Base directory for this skill: /Users/m/.claude/skills/re-assess\n\n" +
      "# Re-assess\n\nLong skill body that should NOT appear..."
    expect(prettifyUserMessageText(raw)).toEqual({
      text: "/re-assess",
      kind: "skill-invocation",
    })
  })

  it("infers a skill name from Base directory path when no command-name tag", () => {
    const raw =
      "Base directory for this skill: /Users/m/.claude/skills/commit\n\n" +
      "Full skill body here that should be hidden."
    expect(prettifyUserMessageText(raw)).toEqual({
      text: "/commit",
      kind: "skill-invocation",
    })
  })

  it("recognizes SKILL CONTENT preamble", () => {
    const raw = "SKILL CONTENT push\nbase dir /tmp/skills/push\n\nbody"
    expect(prettifyUserMessageText(raw)).toEqual({
      text: "/push",
      kind: "skill-invocation",
    })
  })

  it("renders bash-input as a $-prefixed command", () => {
    const raw = "<bash-input>swiz transcript --user-only</bash-input>"
    expect(prettifyUserMessageText(raw)).toEqual({
      text: "$ swiz transcript --user-only",
      kind: "slash-command",
    })
  })

  it("renders bash-stdout as ↳-prefixed output", () => {
    const raw = "<bash-stdout>hello world</bash-stdout>"
    expect(prettifyUserMessageText(raw)).toEqual({
      text: "↳ hello world",
      kind: "command-output",
    })
  })

  it("renders bash-stderr as ✗-prefixed error output", () => {
    const raw = "<bash-stderr>boom</bash-stderr>"
    expect(prettifyUserMessageText(raw)).toEqual({
      text: "✗ boom",
      kind: "command-error",
    })
  })

  it("does not trigger on bash-input embedded in prose", () => {
    const raw = "Note: <bash-input>foo</bash-input> is the syntax."
    expect(prettifyUserMessageText(raw)).toBeUndefined()
  })
})

describe("entryToDisplayTurn user prettification", () => {
  it("prettifies a slash-command user entry", () => {
    const entry = {
      type: "user",
      timestamp: "2026-05-15T14:20:00Z",
      message: {
        content:
          "<command-name>/model</command-name>" +
          "<command-message>model</command-message>" +
          "<command-args></command-args>",
      },
    }
    const turn = entryToDisplayTurn(entry, "user")
    expect(turn.text).toBe("/model")
  })

  it("blanks a pure caveat user entry", () => {
    const entry = {
      type: "user",
      message: {
        content: "<local-command-caveat>ignored</local-command-caveat>",
      },
    }
    const turn = entryToDisplayTurn(entry, "user")
    expect(turn.text).toBe("")
  })

  it("leaves plain user text unchanged", () => {
    const entry = {
      type: "user",
      message: { content: "Hello world" },
    }
    const turn = entryToDisplayTurn(entry, "user")
    expect(turn.text).toBe("Hello world")
  })
})

describe("formatToolUse", () => {
  it("displays exec_command reading a SKILL.md as skill(name)", () => {
    expect(
      formatToolUse("exec_command", { command: "cat /Users/me/.agents/skills/commit/SKILL.md" })
    ).toBe("skill(commit)")
  })

  it("displays Bash reading a SKILL.md via sed -n as skill(name)", () => {
    expect(
      formatToolUse("Bash", { command: "sed -n '1,200p' /Users/me/.claude/skills/push/SKILL.md" })
    ).toBe("skill(push)")
  })

  it("displays Read of a SKILL.md file_path as skill(name)", () => {
    expect(formatToolUse("Read", { file_path: "/Users/me/.claude/skills/commit/SKILL.md" })).toBe(
      "skill(commit)"
    )
  })

  it("does not rewrite non-SKILL.md shell commands", () => {
    expect(formatToolUse("Bash", { command: "git status" })).toBe("Bash(git status)")
    expect(formatToolUse("exec_command", { command: "ls -la" })).toBe("exec_command(ls -la)")
  })

  it("does not treat shell writes to SKILL.md as skill invocations", () => {
    const writeCmd = "echo '# Modified' > /Users/me/.claude/skills/commit/SKILL.md"
    expect(formatToolUse("Bash", { command: writeCmd })).toBe(`Bash(${writeCmd})`)
  })
})
