import { describe, expect, test } from "bun:test"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { useTempDir } from "./test-utils.ts"

const BUN_EXE = Bun.which("bun") ?? "bun"
const { create: createTempDir } = useTempDir("swiz-auto-continue-notify-setting-")

function buildTranscript(toolCallCount: number): string {
  const lines: string[] = [JSON.stringify({ type: "user", message: { content: "continue" } })]
  for (let i = 0; i < toolCallCount; i++) {
    lines.push(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Read", id: `t${i}`, input: {} }] },
      })
    )
  }
  return `${lines.join("\n")}\n`
}

function agentResponse(next: string): string {
  return JSON.stringify({
    next,
    reflections: [],
    processCritique: "",
    productCritique: "",
  })
}

async function createNotifyProbeScript(
  dir: string
): Promise<{ scriptPath: string; markerPath: string }> {
  const markerPath = join(dir, "notify-called.log")
  const scriptPath = join(dir, "swiz-notify-probe.sh")
  await writeFile(
    scriptPath,
    `#!/bin/sh
if [ -n "$SWIZ_NOTIFY_MARKER" ]; then
  echo called >> "$SWIZ_NOTIFY_MARKER"
fi
exit 0
`
  )
  await chmod(scriptPath, 0o755)
  return { scriptPath, markerPath }
}

async function runStopHook(opts: {
  homeDir: string
  transcriptPath: string
  notifyBinPath: string
  markerPath: string
}): Promise<void> {
  const payload = JSON.stringify({
    transcript_path: opts.transcriptPath,
    stop_hook_active: false,
    session_id: "test-session",
    cwd: opts.homeDir,
  })

  const proc = Bun.spawn([BUN_EXE, "hooks/stop-auto-continue.ts"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HOME: opts.homeDir,
      GEMINI_API_KEY: "test-key",
      GEMINI_TEST_RESPONSE: agentResponse("Implement missing behavior"),
      SWIZ_NOTIFY_BIN: opts.notifyBinPath,
      SWIZ_NOTIFY_MARKER: opts.markerPath,
    },
  })

  proc.stdin.write(payload)
  proc.stdin.end()
  await new Response(proc.stdout).text()
  await new Response(proc.stderr).text()
  await proc.exited
}

async function markerWasWritten(markerPath: string, timeoutMs = 2500): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await Bun.file(markerPath).exists()) return true
    await Bun.sleep(50)
  }
  return false
}

describe("stop-auto-continue swiz-notify setting", () => {
  test("does not spawn swiz-notify when swizNotifyHooks is disabled", async () => {
    const homeDir = await createTempDir()
    await mkdir(join(homeDir, ".swiz"), { recursive: true })
    await writeFile(
      join(homeDir, ".swiz", "settings.json"),
      JSON.stringify({ autoContinue: true, swizNotifyHooks: false })
    )

    const transcriptPath = join(homeDir, "transcript.jsonl")
    await writeFile(transcriptPath, buildTranscript(10))
    const { scriptPath, markerPath } = await createNotifyProbeScript(homeDir)

    await runStopHook({
      homeDir,
      transcriptPath,
      notifyBinPath: scriptPath,
      markerPath,
    })

    expect(await markerWasWritten(markerPath)).toBe(false)
  })

  test("spawns swiz-notify when swizNotifyHooks is enabled", async () => {
    const homeDir = await createTempDir()
    await mkdir(join(homeDir, ".swiz"), { recursive: true })
    await writeFile(
      join(homeDir, ".swiz", "settings.json"),
      JSON.stringify({ autoContinue: true, swizNotifyHooks: true })
    )

    const transcriptPath = join(homeDir, "transcript.jsonl")
    await writeFile(transcriptPath, buildTranscript(10))
    const { scriptPath, markerPath } = await createNotifyProbeScript(homeDir)

    await runStopHook({
      homeDir,
      transcriptPath,
      notifyBinPath: scriptPath,
      markerPath,
    })

    expect(await markerWasWritten(markerPath)).toBe(true)
  })
})
