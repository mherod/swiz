import { describe, expect, test } from "bun:test"

async function runHook(
  payload: Record<string, unknown>
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "hooks/notification-swiz-notify.ts"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SWIZ_NOTIFY_BIN: "/nonexistent/swiz-notify" },
  })
  proc.stdin.write(JSON.stringify(payload))
  proc.stdin.end()
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: proc.exitCode ?? 0 }
}

describe("notification-swiz-notify", () => {
  test("exits silently when message is empty", async () => {
    const result = await runHook({ session_id: "test", message: "" })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("")
  })

  test("exits silently when binary not found", async () => {
    // SWIZ_NOTIFY_BIN points to nonexistent path — hook should exit 0 silently
    const result = await runHook({
      session_id: "test",
      message: "Claude needs your permission",
      notification_type: "permission_prompt",
    })
    expect(result.exitCode).toBe(0)
  })

  test("exits silently on invalid JSON", async () => {
    const proc = Bun.spawn(["bun", "hooks/notification-swiz-notify.ts"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    proc.stdin.write("not json")
    proc.stdin.end()
    await proc.exited
    expect(proc.exitCode).toBe(0)
  })
})
