import { describe, expect, test } from "bun:test"
import {
  hasGitNoVerifyFlag,
  hasGitPushForceFlag,
  hasGitStashMutation,
  hasUnsafeGitPushForceFlag,
  quotePosixShellArg,
  splitShellSegments,
  stripQuotedShellStrings,
  tokenizeShellSegment,
  tokenizeShellSegmentWithSpans,
} from "./shell-patterns.ts"
import { useTempDir } from "./test-utils.ts"

const temporary = useTempDir("swiz-shell-argv-")

/** Fixed test inputs only: the shell's git function prints argv and never invokes Git. */
async function shellArgv(command: string): Promise<string[]> {
  const cwd = await temporary.create()
  const proc = Bun.spawn(["sh", "-c", `git() { printf '%s\\0' git "$@"; }\n${command}`], {
    cwd,
    env: { ...process.env, HOME: cwd, AI_TEST_NO_BACKEND: "1" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5000,
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  expect(await proc.exited).toBe(0)
  expect(stderr).toBe("")
  return stdout.split("\0").slice(0, -1)
}

describe("quoted Git arguments (#952)", () => {
  test.each([
    ["push --force", ["push", "--force"], true, false],
    ["commit --no-verify -m message", ["commit", "--no-verify", "-m", "message"], false, true],
  ] as const)("matches shell argv for %s", async (tail, args, force, noVerify) => {
    const command = String.raw`git -C "some\"directory" ${tail}`
    const expected = ["git", "-C", 'some"directory', ...args]
    expect(await shellArgv(command)).toEqual(expected)
    expect(tokenizeShellSegment(command)).toEqual(expected)
    expect(hasGitPushForceFlag(command)).toBe(force)
    expect(hasUnsafeGitPushForceFlag(command)).toBe(force)
    expect(hasGitNoVerifyFlag(command)).toBe(noVerify)
  })

  test.each([
    { source: String.raw`"some\\directory"`, value: String.raw`some\directory` },
    { source: String.raw`"some\\"`, value: "some\\" },
    { source: String.raw`"some\\\"directory"`, value: String.raw`some\"directory` },
    { source: String.raw`"some\q\'directory"`, value: String.raw`some\q\'directory` },
    { source: String.raw`'some\"$directory'`, value: String.raw`some\"$directory` },
    { source: '"🐛 café \\"目录\\"\\\\tail"', value: '🐛 café "目录"\\tail' },
    { source: '"left\\\nright"', value: "leftright" },
    { source: '"left\nright"', value: "left\nright" },
    { source: '""', value: "" },
    { source: "''", value: "" },
    { source: String.raw`pre"some\""post' tail'`, value: 'presome"post tail' },
    { source: '"literal \\$HOME \\`uname\\`"', value: "literal $HOME `uname`" },
    { source: String.raw`some\ directory`, value: "some directory" },
  ])("preserves shell argv and UTF-16 source spans: $source", async ({ source, value }) => {
    const words = ["git", "-C", source, "status"]
    const command = ` \t${words.join(" \t")} \t`
    const expected = ["git", "-C", value, "status"]
    expect(await shellArgv(command)).toEqual(expected)
    expect(tokenizeShellSegment(command)).toEqual(expected)
    let offset = 2
    const spans = words.map((word, index) => {
      const span = { value: expected[index]!, start: offset, end: offset + word.length }
      offset += word.length + 2
      return span
    })
    expect(tokenizeShellSegmentWithSpans(command)).toEqual(spans)
    expect(spans.map(({ start, end }) => command.slice(start, end))).toEqual(words)
  })

  test("preserves substitution text without evaluating it", () => {
    const source = '"$HOME $(printf unsafe) `uname`"'
    expect(tokenizeShellSegment(`git -C ${source} status`)).toEqual([
      "git",
      "-C",
      "$HOME $(printf unsafe) `uname`",
      "status",
    ])
  })

  test("keeps escaped quoted separators inside their segment", () => {
    const command = String.raw`git -C "some\";&&|directory" push --force`
    expect(splitShellSegments(`${command} && git status`)).toEqual([command, "git status"])
    expect(hasUnsafeGitPushForceFlag(`${command} && git status`)).toBe(true)
  })

  test.each([
    String.raw`git -C "some\"directory" push -- --force`,
    String.raw`git -C "some\"directory" commit -- --no-verify`,
    String.raw`echo "example \"git push --force\" and git commit --no-verify"`,
  ])("keeps inert flags inactive: %s", (command) => {
    expect(hasGitPushForceFlag(command)).toBe(false)
    expect(hasUnsafeGitPushForceFlag(command)).toBe(false)
    expect(hasGitNoVerifyFlag(command)).toBe(false)
  })
})

describe("quotePosixShellArg", () => {
  test("safe words pass through bare", () => {
    expect(quotePosixShellArg("src/mine.ts")).toBe("src/mine.ts")
  })

  test("metacharacters force single quoting even without whitespace", () => {
    expect(quotePosixShellArg("a$(cmd).ts")).toBe("'a$(cmd).ts'")
    expect(quotePosixShellArg("b`tick`.ts")).toBe("'b`tick`.ts'")
  })

  test("option-like and zsh-expansion-prone leading characters are quoted", () => {
    expect(quotePosixShellArg("-rf.ts")).toBe("'-rf.ts'")
    expect(quotePosixShellArg("=cmd.ts")).toBe("'=cmd.ts'")
    // Control: the same characters mid-word stay bare.
    expect(quotePosixShellArg("a-b=c.ts")).toBe("a-b=c.ts")
  })

  test("embedded single quotes use the POSIX splice and empty strings quote", () => {
    expect(quotePosixShellArg("it's.ts")).toBe("'it'\\''s.ts'")
    expect(quotePosixShellArg("")).toBe("''")
  })
})

describe("stripQuotedShellStrings", () => {
  test("preserves empty quote pairs when requested", () => {
    const command = `cmd --message "hello world" --note 'done'`
    expect(stripQuotedShellStrings(command, { preserveQuotePairs: true })).toBe(
      `cmd --message "" --note ''`
    )
  })

  test("respects escaped double quotes inside double-quoted strings", () => {
    const command = String.raw`cmd "a \"quoted\" value" tail`
    expect(stripQuotedShellStrings(command, { preserveQuotePairs: true })).toBe(`cmd "" tail`)
  })

  test("can also strip backtick strings for diagnostic command matching", () => {
    const command = "cmd \"value\" `inner` 'tail'"
    expect(stripQuotedShellStrings(command, { stripBackticks: true })).toBe("cmd   ")
  })
})

describe("splitShellSegments", () => {
  test("splits executable segments on unquoted shell operators", () => {
    expect(splitShellSegments("rg foo hooks | bun test && git status; swiz settings")).toEqual([
      "rg foo hooks",
      "bun test",
      "git status",
      "swiz settings",
    ])
  })

  test("preserves quoted operators as argument text", () => {
    expect(splitShellSegments('rg "|bun test" file.ts; grep "& done" hooks/*.ts')).toEqual([
      'rg "|bun test" file.ts',
      'grep "& done" hooks/*.ts',
    ])
  })

  test("does not split file descriptor redirects on ampersand", () => {
    expect(splitShellSegments("bun test src/foo.test.ts 2>&1 > out.log")).toEqual([
      "bun test src/foo.test.ts 2>&1 > out.log",
    ])
  })
})

describe("hasGitStashMutation", () => {
  test("detects a mutating stash before a read-only stash in a multiline command", () => {
    const command = [
      "git stash push -u -m 'preserve concurrent work'",
      "STASH_OID=$(git rev-parse --verify refs/stash)",
      'git stash show -u --stat "$STASH_OID"',
    ].join("\n")

    expect(hasGitStashMutation(command)).toBe(true)
  })

  test("allows commands containing only read-only stash invocations", () => {
    expect(hasGitStashMutation("git stash list\ngit -C /repo stash show stash@{0}")).toBe(false)
  })

  test("detects bare and global-option stash mutations", () => {
    expect(hasGitStashMutation("git stash")).toBe(true)
    expect(hasGitStashMutation("command git -C /repo stash pop")).toBe(true)
  })

  test("ignores stash examples inside another command's quoted argument", () => {
    expect(hasGitStashMutation('echo "do not run git stash push"')).toBe(false)
  })
})
