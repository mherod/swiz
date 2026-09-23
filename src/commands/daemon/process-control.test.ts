import { expect, test } from "bun:test"
import { chmodSync } from "node:fs"
import { join } from "node:path"
import { type LaunchAgentRuntime, SWIZ_DAEMON_LABEL } from "../../launch-agents.ts"
import { useTempDir } from "../../utils/test-utils"
import { restartDaemon } from "./process-control.ts"

const temporary = useTempDir("swiz-restart-")
const indexPath = join(import.meta.dir, "../../../index.ts")

async function fixture() {
  const cwd = await temporary.create()
  const plistPath = join(cwd, "daemon.plist")
  await Bun.write(plistPath, "fixture")
  const commands: string[][] = []
  const state = {
    loaded: true,
    pid: 101 as number | null,
    replacementPid: 202,
    lastExitCode: 0,
    failure: "",
    exitCode: 5,
    diagnostic: "Operation not permitted",
  }
  const runtime: LaunchAgentRuntime = {
    getUid: () => 42,
    kill: () => {
      throw new Error("LaunchAgent restart must not kill by port")
    },
    async run(command) {
      commands.push(command)
      const action = command[1]
      if (action === state.failure)
        return { exitCode: state.exitCode, stdout: "", stderr: state.diagnostic }
      if (action === "print")
        return state.loaded
          ? {
              exitCode: 0,
              stdout: `state = running\n${state.pid ? `pid = ${state.pid}\n` : ""}last exit code = ${state.lastExitCode}\n`,
              stderr: "",
            }
          : {
              exitCode: 113,
              stdout: "",
              stderr: `Could not find service "${SWIZ_DAEMON_LABEL}" in domain for user gui: 42`,
            }
      if (action === "bootstrap") state.loaded = true
      else if (action === "kickstart") state.pid = state.replacementPid
      else throw new Error(`Unexpected command: ${command.join(" ")}`)
      return {
        exitCode: 0,
        stdout: action === "kickstart" ? String(state.replacementPid) : "",
        stderr: "",
      }
    },
  }
  const options: NonNullable<Parameters<typeof restartDaemon>[2]> = {
    runtime,
    plistPath,
    timeoutMs: 1000,
    pollMs: 1,
    fetchHealth: async () =>
      new Response("ok", { headers: { "x-swiz-daemon-pid": String(state.replacementPid) } }),
  }
  return { state, commands, options }
}

test("waits for the replacement's health instead of accepting the old listener", async () => {
  const f = await fixture()
  let probes = 0
  f.options.fetchHealth = async (_url, init) => {
    expect(init.signal).toBeInstanceOf(AbortSignal)
    probes++
    return new Response("ok", { headers: { "x-swiz-daemon-pid": probes < 3 ? "101" : "202" } })
  }
  expect(await restartDaemon(1234, 999, f.options)).toEqual({
    mode: "launchagent",
    hadRunning: true,
    stoppedCount: 1,
  })
  expect(probes).toBe(3)
  expect(f.commands.slice(0, 2)).toEqual([
    ["launchctl", "print", "gui/42/com.swiz.daemon"],
    ["launchctl", "kickstart", "-k", "-p", "gui/42/com.swiz.daemon"],
  ])
})

test.each(["missing", "stopped"])("starts an installed %s job", async (kind) => {
  const f = await fixture()
  f.state.loaded = kind !== "missing"
  f.state.pid = null
  expect(await restartDaemon(1234, 999, f.options)).toEqual({
    mode: "launchagent",
    hadRunning: false,
    stoppedCount: 0,
  })
  expect(f.commands.filter((command) => command[1] === "bootstrap")).toEqual(
    kind === "missing" ? [["launchctl", "bootstrap", "gui/42", f.options.plistPath!]] : []
  )
})

test.each([
  "print",
  "kickstart",
  "bootstrap",
])("preserves %s failure diagnostics without falling back", async (action) => {
  const f = await fixture()
  f.state.loaded = action !== "bootstrap"
  f.state.failure = action
  await expect(restartDaemon(1234, 999, f.options)).rejects.toThrow("Operation not permitted")
  expect(f.commands.at(-1)?.[1]).toBe(action)
})

test("does not mistake a missing GUI domain for a missing service", async () => {
  const f = await fixture()
  f.state.failure = "print"
  f.state.exitCode = 113
  f.state.diagnostic = "Could not find domain for user gui: 42"
  await expect(restartDaemon(1234, 999, f.options)).rejects.toThrow(f.state.diagnostic)
  expect(f.commands).toHaveLength(1)
})

test("rejects a successful kickstart that leaves the original process running", async () => {
  const f = await fixture()
  f.state.replacementPid = 101
  await expect(restartDaemon(1234, 999, f.options)).rejects.toThrow("did not replace PID 101")
})

test.each([
  "wrong PID",
  "missing PID",
  "HTTP failure",
  "connection failure",
  "timeout",
])("bounds health verification for %s", async (kind) => {
  const f = await fixture()
  f.options.timeoutMs = 30
  f.options.fetchHealth = async (_url, init) => {
    if (kind === "connection failure") throw new Error("connection refused")
    if (kind === "timeout")
      return new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(new Error("probe timed out")), {
          once: true,
        })
      })
    return new Response("ok", {
      status: kind === "HTTP failure" ? 503 : 200,
      headers:
        kind === "missing PID" ? {} : { "x-swiz-daemon-pid": kind === "wrong PID" ? "101" : "202" },
    })
  }
  await expect(restartDaemon(1234, 999, f.options)).rejects.toThrow("Timed out waiting")
})

test("reports a replacement that crashes during startup", async () => {
  const f = await fixture()
  f.options.fetchHealth = async () => {
    f.state.pid = null
    f.state.lastExitCode = 78
    return new Response("starting", { status: 503 })
  }
  await expect(restartDaemon(1234, 999, f.options)).rejects.toThrow("last exit 78")
})

test("preserves port fallback when no LaunchAgent plist is installed", async () => {
  const cwd = await temporary.create()
  const lsof = join(cwd, "lsof")
  await Bun.write(lsof, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOME/lsof.log"\nexit 1\n')
  chmodSync(lsof, 0o755)
  const modulePath = join(import.meta.dir, "process-control.ts")
  const proc = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `import { restartDaemon } from ${JSON.stringify(modulePath)}; process.stdout.write(JSON.stringify(await restartDaemon(1234)))`,
    ],
    {
      cwd,
      env: {
        ...process.env,
        HOME: cwd,
        PATH: `${cwd}:${process.env.PATH}`,
        AI_TEST_NO_BACKEND: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    }
  )
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  expect(await proc.exited).toBe(0)
  expect(stderr).toBe("")
  expect(JSON.parse(stdout)).toEqual({ mode: "port", hadRunning: false, stoppedCount: 0 })
  expect(await Bun.file(join(cwd, "lsof.log")).text()).toBe("-ti tcp:1234\n-ti tcp:1234\n")
})

test.each([
  "success",
  "denied",
  "unchanged",
  "unhealthy",
])("CLI verifies a GUI job invisible to legacy list: %s", async (scenario) => {
  const cwd = await temporary.create()
  const commandLog = join(cwd, "commands.log")
  const replacement = join(cwd, "replacement")
  await Bun.write(join(cwd, "Library/LaunchAgents/com.swiz.daemon.plist"), "fixture")
  const launchctl = join(cwd, "launchctl")
  await Bun.write(
    launchctl,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/commands.log"
case "$1" in
  list) exit 1 ;;
  print)
    if [ "$RESTART_SCENARIO" = denied ]; then printf 'Operation not permitted\\n' >&2; exit 5; fi
    if [ -f "$HOME/replacement" ]; then pid=202; else pid=101; fi
    printf 'state = running\\npid = %s\\n' "$pid"
    ;;
  kickstart)
    if [ "$RESTART_SCENARIO" = unchanged ]; then printf '101\\n'; exit 0; fi
    printf '202' > "$HOME/replacement"; printf '202\\n'
    ;;
  load) exit 0 ;;
  *) exit 90 ;;
esac
`
  )
  chmodSync(launchctl, 0o755)
  let probes = 0
  const server = Bun.serve({
    port: 0,
    async fetch() {
      probes++
      const ready = scenario !== "unhealthy" && (await Bun.file(replacement).exists())
      return new Response("ok", {
        status: ready ? 200 : 503,
        headers: { "x-swiz-daemon-pid": "202" },
      })
    },
  })
  try {
    const proc = Bun.spawn(
      [process.execPath, indexPath, "daemon", "--restart", "--port", String(server.port)],
      {
        cwd,
        env: {
          ...process.env,
          HOME: cwd,
          PATH: `${cwd}:${process.env.PATH}`,
          SWIZ_DIRECT: "1",
          AI_TEST_NO_BACKEND: "1",
          RESTART_SCENARIO: scenario,
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15000,
      }
    )
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const exitCode = await proc.exited
    if (scenario === "success") {
      expect(exitCode).toBe(0)
      expect(stderr).toBe("")
      expect(stdout).toContain("reloaded via launchctl")
      expect(await Bun.file(commandLog).text()).toContain(
        `kickstart -k -p gui/${process.getuid?.()}/com.swiz.daemon`
      )
      expect(probes).toBeGreaterThan(0)
    } else {
      expect(exitCode).toBe(1)
      expect(stdout).not.toContain("via launchctl")
      expect(stderr).toContain(
        scenario === "denied"
          ? "Operation not permitted"
          : scenario === "unchanged"
            ? "did not replace PID"
            : "Timed out waiting"
      )
    }
    expect(await Bun.file(commandLog).text()).not.toMatch(/^(list|load|unload) /m)
  } finally {
    await server.stop(true)
  }
}, 20_000)
