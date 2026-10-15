import { describe, expect, test } from "bun:test"
import { parseIdeaArgs } from "./idea.ts"
import { parseReflectArgs } from "./reflect.ts"

describe("shared command value options", () => {
  for (const [name, parse] of [
    ["idea", parseIdeaArgs],
    ["reflect", parseReflectArgs],
  ] as const) {
    test(`${name} preserves aliases and consumes values`, () => {
      expect(parse(["-m", "example", "-t", "12ms", "-j"])).toMatchObject({
        model: "example",
        timeoutMs: 12,
        json: true,
      })
    })

    test(`${name} rejects missing and invalid values`, () => {
      for (const value of ["0", "-2", "invalid"]) {
        expect(() => parse(["--timeout", value])).toThrow(
          `--timeout must be a positive integer, got: ${value}`
        )
      }
      expect(() => parse(["-m"])).toThrow("Missing value for --model")
      expect(() => parse(["-m", ""])).toThrow("Missing value for --model")
    })
  }

  test("preserves command-specific short flags and count diagnostics", () => {
    expect(parseIdeaArgs(["-p", "gemini"]).provider).toBe("gemini")
    expect(parseReflectArgs(["-p"]).printPrompt).toBe(true)
    expect(() => parseReflectArgs(["-n", "0"])).toThrow("-n must be a positive integer, got: 0")
    expect(() => parseReflectArgs(["2", "-n", "3"])).toThrow("Count already specified")
  })
})
