/** Stop Codex writers before removing their rollouts. Inspection failures fail closed. */
export interface CodexProcess {
  pid: number
  executable: string
  appPath?: string
}

export interface CodexProcessRuntime {
  inspect: () => Promise<CodexProcess[]>
  quitApps: (processes: CodexProcess[]) => Promise<void>
  terminate: (processes: CodexProcess[], signal: "TERM" | "KILL") => Promise<void>
  wait: (ms: number) => Promise<void>
}

/** Parse executable names, not arguments that might merely mention Codex. */
export function parseCodexProcesses(stdout: string): CodexProcess[] {
  if (!stdout.trim()) throw new Error("Process inspection returned no data")
  const processes: CodexProcess[] = []
  for (const line of stdout.trim().split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/)
    if (!match) throw new Error("Could not parse process inspection output")
    const pid = Number(match[1])
    const executable = match[2]!
    const name = executable.slice(executable.lastIndexOf("/") + 1)
    const isCodex =
      /^codex(?:$|[- ])/i.test(name) ||
      /\/codex[^/]*\.app\/contents\//i.test(executable) ||
      /\/codex framework\.framework\//i.test(executable)
    if (!isCodex) continue
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid Codex process ID")
    processes.push({
      pid,
      executable,
      appPath: executable.match(/^(.*?\.app)\/contents\//i)?.[1],
    })
  }
  return processes
}

async function runProcessCommand(args: string[]): Promise<string> {
  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5_000,
    killSignal: "SIGKILL",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if ((await proc.exited) !== 0) throw new Error(stderr.trim() || `${args[0]} failed`)
  return stdout
}

function appleScriptString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

export function createCodexProcessRuntime(
  run = runProcessCommand,
  platform: NodeJS.Platform = process.platform
): CodexProcessRuntime {
  return {
    inspect: async () => parseCodexProcesses(await run(["ps", "-axo", "pid=,comm="])),
    async quitApps(processes) {
      if (platform !== "darwin") return
      for (const app of new Set(processes.map((p) => p.appPath).filter(Boolean))) {
        const target = appleScriptString(app!)
        await run([
          "osascript",
          "-e",
          `if application ${target} is running then tell application ${target} to quit`,
        ])
      }
    },
    async terminate(processes, signal) {
      const pids = processes.map((p) => p.pid)
      if (pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid)) {
        throw new Error("Refusing an unsafe process target")
      }
      if (pids.length === 0) return
      const args = ["/bin/kill", `-${signal}`, ...pids.map(String)]
      if (platform === "darwin") {
        await run(["osascript", "-e", `do shell script ${appleScriptString(args.join(" "))}`])
      } else {
        await run(args)
      }
    },
    wait: async (ms) => {
      await Bun.sleep(ms)
    },
  }
}

async function waitForCodexExit(runtime: CodexProcessRuntime): Promise<CodexProcess[]> {
  let remaining: CodexProcess[] = []
  for (let attempt = 0; attempt < 20; attempt++) {
    await runtime.wait(100)
    remaining = await runtime.inspect()
    if (remaining.length === 0) break
  }
  return remaining
}

async function stopCodex(
  processes: CodexProcess[],
  runtime: CodexProcessRuntime
): Promise<CodexProcess[]> {
  // A refused or timed-out quit can still be followed by explicit --force signals.
  await runtime.quitApps(processes).catch(() => {})
  let remaining = await waitForCodexExit(runtime)
  for (const signal of ["TERM", "KILL"] as const) {
    if (remaining.length === 0) break
    await runtime.terminate(remaining, signal).catch(() => {})
    remaining = await waitForCodexExit(runtime)
  }
  return remaining
}

export async function prepareCodexCleanup(
  options: { force?: boolean; dryRun: boolean },
  runtime: CodexProcessRuntime
): Promise<{ allowed: boolean; stopped?: boolean; message?: string }> {
  try {
    const processes = await runtime.inspect()
    if (processes.length === 0) return { allowed: true }
    if (!options.force) {
      return {
        allowed: false,
        message: "Skipping Codex cleanup: Codex is running; use --force to quit it first.",
      }
    }
    if (options.dryRun) {
      return { allowed: true, message: "Dry run: would quit Codex and stop its processes first." }
    }
    const remaining = await stopCodex(processes, runtime)
    if (remaining.length > 0) {
      return {
        allowed: false,
        message: "Skipping Codex cleanup: Codex processes are still running.",
      }
    }
    return { allowed: true, stopped: true, message: "Stopped Codex before cleanup." }
  } catch (error) {
    return {
      allowed: false,
      message: `Skipping Codex cleanup: process inspection failed (${error}).`,
    }
  }
}
