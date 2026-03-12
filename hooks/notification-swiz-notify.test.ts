import { describe, expect, test } from "bun:test"

async function runHook(
  payload: Record<string, unknown>,
  env: Record<string, string> = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "hooks/notification-swiz-notify.ts"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SWIZ_NOTIFY_BIN: "/nonexistent/swiz-notify", ...env },
  })
  void proc.stdin.write(JSON.stringify(payload))
  void proc.stdin.end()
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
      env: { ...process.env, SWIZ_NOTIFY_BIN: "/nonexistent/swiz-notify" },
    })
    void proc.stdin.write("not json")
    void proc.stdin.end()
    await proc.exited
    expect(proc.exitCode).toBe(0)
  })

  test("exits silently when binary not found for idle_prompt", async () => {
    const result = await runHook({
      session_id: "test",
      message: "Waiting for your input",
      notification_type: "idle_prompt",
    })
    expect(result.exitCode).toBe(0)
  })

  test("exits silently for unknown notification type", async () => {
    const result = await runHook({
      session_id: "test",
      message: "Something happened",
      notification_type: "unknown_type",
    })
    expect(result.exitCode).toBe(0)
  })
})
