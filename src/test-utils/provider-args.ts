import { describe, expect, test } from "bun:test"

/**
 * Register the provider CLI contract inside a command's parser suite.
 * Pass required positional args separately so missing-value cases end at the flag.
 * Example: testProviderArgs(parseMergetoolArgs, { args: ["/base", "/ours", "/theirs", "/merged"] })
 */
export function testProviderArgs(
  parse: (args: string[]) => { provider?: string },
  options: { args?: string[]; aliases?: string[] } = {}
): void {
  const args = options.args ?? []
  describe("provider option", () => {
    for (const flag of ["--provider", ...(options.aliases ?? [])]) {
      test.each([
        "gemini",
        "claude",
        "openrouter",
        "codex",
        "agy",
      ])(`${flag} accepts %s`, (provider) => {
        expect(parse([flag, provider, ...args]).provider).toBe(provider)
      })
    }

    test("leaves the provider unset when omitted", () => {
      expect(parse([...args]).provider).toBeUndefined()
    })

    test("rejects an unsupported provider", () => {
      expect(() => parse(["--provider", "openai", ...args])).toThrow(
        'must be "gemini", "claude", "openrouter", "codex", or "agy"'
      )
    })

    test("rejects missing and empty provider values", () => {
      expect(() => parse([...args, "--provider"])).toThrow("Missing value for --provider")
      expect(() => parse([...args, "--provider", ""])).toThrow("Missing value for --provider")
    })

    test("uses the last explicit provider", () => {
      expect(parse([...args, "--provider", "gemini", "--provider", "codex"]).provider).toBe("codex")
    })
  })
}
