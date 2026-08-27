import { describe, expect, it } from "bun:test"
import {
  isClaudeCliExecutable,
  isCodexCliExecutable,
  parseProviderPids,
} from "./agent-process-discovery.ts"

// Process shapes observed live in issue #835 — six real Claude sessions on a
// machine where the old `claude-agent-sdk/cli.js` substring matched nothing.
const PS_FIXTURE = [
  "  17194     1 /usr/bin/script -q /dev/null /Users/user/.local/bin/claude",
  "  17195 17194 /Users/user/.local/bin/claude",
  "  17259 17258 claude",
  "  33626 43340 claude --dangerously-skip-permissions",
  "  90001 17195 claude mcp serve",
  "  40001     1 /Applications/Claude.app/Contents/MacOS/Claude",
  "  40002 40001 /Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer) --type=renderer",
  "  40003     1 /Applications/Claude.app/Contents/Helpers/disclaimer --pgroup -- /Users/user/.bun/bin/swiz mcp",
  "  40004     1 /Users/user/Library/chrome-native-host chrome-extension://abcdef claude",
  "  50001     1 /opt/homebrew/bin/gemini",
  "  60001     1 bun /Users/user/.bun/bin/swiz daemon --port 7943",
].join("\n")

describe("isClaudeCliExecutable", () => {
  it("matches the bare executable and absolute paths ending /claude", () => {
    expect(isClaudeCliExecutable("claude")).toBe(true)
    expect(isClaudeCliExecutable("/users/user/.local/bin/claude")).toBe(true)
  })

  it("rejects desktop-app binaries under /Applications", () => {
    expect(isClaudeCliExecutable("/applications/claude.app/contents/macos/claude")).toBe(false)
  })

  it("rejects executables that merely mention claude elsewhere", () => {
    expect(isClaudeCliExecutable("/usr/bin/script")).toBe(false)
    expect(isClaudeCliExecutable("/users/user/library/chrome-native-host")).toBe(false)
    expect(isClaudeCliExecutable("claude-helper")).toBe(false)
  })
})

describe("parseProviderPids claude classification", () => {
  const providers = parseProviderPids(PS_FIXTURE)
  const claude = providers.get("claude") ?? new Set<number>()

  it("classifies each real session exactly once", () => {
    expect([...claude].sort((a, b) => a - b)).toEqual([17195, 17259, 33626])
  })

  it("does not count the script wrapper for a session it spawned", () => {
    expect(claude.has(17194)).toBe(false)
  })

  it("collapses a claude subprocess onto its parent session", () => {
    expect(claude.has(90001)).toBe(false)
  })

  it("excludes /Applications desktop-app processes", () => {
    expect(claude.has(40001)).toBe(false)
    expect(claude.has(40002)).toBe(false)
    expect(claude.has(40003)).toBe(false)
  })

  it("control: non-claude processes keep their own classification", () => {
    expect(claude.has(40004)).toBe(false)
    expect(claude.has(60001)).toBe(false)
    expect(providers.get("gemini")?.has(50001)).toBe(true)
  })
})

describe("Codex process classification", () => {
  const desktopCodex = "/applications/chatgpt.app/contents/resources/codex"
  const frameworkRenderer =
    "/applications/chatgpt.app/contents/frameworks/codex framework.framework/helpers/codex (renderer)"

  it("matches actual Codex CLI executables, including desktop agent workers", () => {
    expect(isCodexCliExecutable("codex --profile default", "codex")).toBe(true)
    expect(isCodexCliExecutable(desktopCodex, desktopCodex)).toBe(true)
  })

  it("rejects Electron renderers, crash handlers, and code-mode hosts", () => {
    expect(
      isCodexCliExecutable(frameworkRenderer, "/applications/chatgpt.app/contents/frameworks/codex")
    ).toBe(false)
    expect(
      isCodexCliExecutable(
        "/applications/chatgpt.app/contents/resources/codex-code-mode-host",
        "/applications/chatgpt.app/contents/resources/codex-code-mode-host"
      )
    ).toBe(false)
    expect(
      isCodexCliExecutable(
        "/applications/chatgpt.app/contents/frameworks/codex framework.framework/helpers/browser_crashpad_handler",
        "/applications/chatgpt.app/contents/frameworks/codex"
      )
    ).toBe(false)
    expect(
      isCodexCliExecutable(
        "/users/example/.codex/computer-use/codex computer use.app/contents/macos/skycomputeruseservice",
        "/users/example/.codex/computer-use/codex"
      )
    ).toBe(false)
  })

  it("counts only agent executables from mixed Codex desktop process rows", () => {
    const fixture = [
      "101 1 /Applications/ChatGPT.app/Contents/Resources/codex",
      "102 1 codex --profile default",
      "103 1 /Applications/ChatGPT.app/Contents/Resources/codex-code-mode-host",
      "104 1 /Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex (Renderer)",
      "105 1 /Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/browser_crashpad_handler",
      "106 1 /Users/example/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService",
    ].join("\n")

    expect([...(parseProviderPids(fixture).get("codex") ?? [])]).toEqual([101, 102])
  })
})

async function psRow(pid: number): Promise<{ ppid: number; executable: string } | null> {
  const proc = Bun.spawn(["ps", "-p", String(pid), "-o", "ppid=,command="], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  if (proc.exitCode !== 0) return null
  const match = stdout.trim().match(/^(\d+)\s+(.+)$/)
  if (!match) return null
  const command = (match[2] ?? "").toLowerCase()
  return { ppid: Number(match[1]), executable: command.split(/\s+/, 1)[0] ?? "" }
}

describe("live self-test (issue #835)", () => {
  it("detects the claude session this test runs inside, when there is one", async () => {
    // Walk our own ancestry looking for a claude CLI process. On CI there is
    // none and the assertion is vacuously satisfied; on a dev machine running
    // inside a Claude session, the classifier that cannot see its own session
    // is wrong — this is the issue's portable self-test.
    let pid = process.ppid
    let claudeAncestor: number | null = null
    for (let hop = 0; hop < 20 && pid > 1; hop++) {
      const row = await psRow(pid)
      if (!row) break
      if (isClaudeCliExecutable(row.executable)) {
        claudeAncestor = pid
        break
      }
      pid = row.ppid
    }
    if (claudeAncestor === null) return

    const proc = Bun.spawn(["ps", "-Ao", "pid,ppid,command"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    const providers = parseProviderPids(stdout)
    expect(providers.get("claude")?.has(claudeAncestor)).toBe(true)
  })
})
