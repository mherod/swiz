#!/usr/bin/env bun
/** Adapter entrypoint: preserve authentication, isolate generation from workspace configuration. */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

async function main(): Promise<void> {
  const executable = process.env.SWIZ_CODEX_EXECUTABLE
  if (!executable) throw new Error("Missing Codex generation executable")
  const cwd = await mkdtemp(join(tmpdir(), "swiz-codex-generation-"))
  try {
    const proc = Bun.spawn(
      [executable, ...process.argv.slice(2), "--ignore-user-config", "--ephemeral"],
      { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" }
    )
    const terminate = () => proc.kill("SIGTERM")
    process.on("SIGTERM", terminate)
    process.on("SIGINT", terminate)
    try {
      await proc.exited
      process.exitCode = proc.exitCode ?? 1
    } finally {
      process.off("SIGTERM", terminate)
      process.off("SIGINT", terminate)
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

if (import.meta.main) void main()
