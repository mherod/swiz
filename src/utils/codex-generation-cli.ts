#!/usr/bin/env bun
/** Adapter entrypoint: preserve authentication, isolate generation from workspace configuration. */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

async function forwardOutput(
  stdout: ReadableStream<Uint8Array>,
  onEvent: (type: string) => void
): Promise<void> {
  const decoder = new TextDecoder()
  let pending = ""
  const inspectLine = (line: string) => {
    try {
      const event: unknown = JSON.parse(line)
      if (event && typeof event === "object" && "type" in event && typeof event.type === "string") {
        onEvent(event.type)
      }
    } catch {
      // Preserve non-JSON output; only complete protocol events end generation.
    }
  }
  const reader = stdout.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      await Bun.write(Bun.stdout, value)
      const lines = (pending + decoder.decode(value, { stream: true })).split(/\r?\n/)
      pending = lines.pop() ?? ""
      for (const line of lines) inspectLine(line)
    }
  } finally {
    reader.releaseLock()
  }
  inspectLine(pending + decoder.decode())
}

async function main(): Promise<void> {
  const executable = process.env.SWIZ_CODEX_EXECUTABLE
  if (!executable) throw new Error("Missing Codex generation executable")
  const cwd = await mkdtemp(join(tmpdir(), "swiz-codex-generation-"))
  try {
    const proc = Bun.spawn(
      [executable, ...process.argv.slice(2), "--ignore-user-config", "--ephemeral"],
      { cwd, stdin: "inherit", stdout: "pipe", stderr: "inherit" }
    )
    let completed = false
    let failed = false
    let aborted = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const stopChild = () => {
      if (killTimer || proc.exitCode !== null) return
      proc.kill("SIGTERM")
      killTimer = setTimeout(() => proc.kill("SIGKILL"), 1000)
    }
    const terminate = () => {
      aborted = true
      stopChild()
    }
    process.on("SIGTERM", terminate)
    process.on("SIGINT", terminate)
    try {
      await Promise.all([
        proc.exited,
        forwardOutput(proc.stdout, (type) => {
          if (type === "error" || type === "turn.failed") failed = true
          if (type !== "turn.completed") return
          // Codex can keep its app-server alive after a successful single turn.
          // Forward the final event before stopping our isolated child process.
          completed = !failed && !aborted
          stopChild()
        }),
      ])
      process.exitCode = aborted || failed ? 1 : completed ? 0 : (proc.exitCode ?? 1)
    } finally {
      stopChild()
      await proc.exited
      clearTimeout(killTimer)
      process.off("SIGTERM", terminate)
      process.off("SIGINT", terminate)
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

if (import.meta.main) void main()
