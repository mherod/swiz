import { expect, test } from "bun:test"
import { chmodSync } from "node:fs"
import { join } from "node:path"
import { type LaunchAgentRuntime, SWIZ_DAEMON_LABEL } from "../../launch-agents.ts"
import { useTempDir } from "../../utils/test-utils"
import { listDaemonPids, restartDaemon, restartDaemonOnPort } from "./process-control.ts"

const temporary = useTempDir("swiz-restart-")
const indexPath = join(import.meta.dir, "../../../index.ts")

test
  .skipIf(!["darwin", "linux"].includes(process.platform) || !Bun.which("lsof"))
  .each(["127.0.0.1", "::1"])(
  "selects only the %s listener while a separate client is connected",
  async (hostname) => {
    const cwd = await temporary.create()
    const sockets = new Set<Bun.Socket<undefined>>()
    const listener = Bun.listen({
      hostname,
      port: 0,
      socket: {
        open(socket) {
          sockets.add(socket)
        },
        data(socket) {
          socket.write("ready")
        },
        close(socket) {
          sockets.delete(socket)
        },
      },
    })
    const client = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
    const socket = await Bun.connect({
      hostname: ${JSON.stringify(hostname)}, port: ${listener.port},
      socket: {
        open(socket) { socket.write("connect") },
        data() { process.stdout.write("ready\\n") },
        close() {},
      },
    });
    await Bun.stdin.text();
    socket.end();
  `,
      ],
      {
        cwd,
        env: { ...process.env, HOME: cwd, AI_TEST_NO_BACKEND: "1" },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 8000,
      }
    )
    const errors = new Response(client.stderr).text()
    const ready = client.stdout.getReader()
    try {
      const chunk = await ready.read()
      expect(new TextDecoder().decode(chunk.value)).toBe("ready\n")
      const pids = await listDaemonPids(listener.port)
      expect(pids).toEqual([process.pid])
      expect(pids).not.toContain(client.pid)
      const signals: Array<[number, string | undefined]> = []
      const operations = {
        kill: (pid: number, signal?: NodeJS.Signals) => {
          signals.push([pid, signal])
        },
        wait: async () => {},
      }
      // The real selector is exercised on every pass, but every signal is a spy.
      expect(await restartDaemonOnPort(listener.port, process.pid, operations)).toBe(0)
      expect(signals).toEqual([])
      await expect(restartDaemonOnPort(listener.port, 0, operations)).rejects.toThrow(
        "still in use"
      )
      expect(signals).toEqual([
        [process.pid, undefined],
        [process.pid, "SIGKILL"],
      ])
      operations.kill = (pid, signal) => {
        signals.push([pid, signal])
        listener.stop()
      }
      expect(await restartDaemonOnPort(listener.port, 0, operations)).toBe(1)
      expect(signals.at(-1)).toEqual([process.pid, undefined])
      expect(signals.some(([pid]) => pid === client.pid)).toBe(false)
      expect(client.exitCode).toBeNull()
    } finally {
      await client.stdin.end()
      for (const socket of sockets) socket.end()
      listener.stop()
      await ready.cancel()
      expect(await client.exited).toBe(0)
      expect(await errors).toBe("")
    }
  },
  10_000
)

test.each([
  { exitCode: 0, stdout: "42\n42\n84\n", expected: [42, 84] },
  { exitCode: 1, stdout: "", expected: [] },
  { exitCode: 0, stdout: "", expected: [] },
])("parses listener rows: %j", async ({ exitCode, stdout, expected }) => {
  const commands: string[][] = []
  expect(
    await listDaemonPids(1234, async (command) => {
      commands.push(command)
      return { exitCode, stdout, stderr: "" }
    })
  ).toEqual([...expected])
  expect(commands).toEqual([["lsof", "-nP", "-t", "+w", "-a", "-iTCP:1234", "-sTCP:LISTEN"]])
})

test.each([
  { exitCode: 1, stdout: "", stderr: "permission denied", message: "permission denied" },
  { exitCode: 2, stdout: "", stderr: "", message: "lsof exited 2" },
  { exitCode: 1, stdout: "42\n", stderr: "", message: "lsof exited 1" },
  { exitCode: 0, stdout: "42\n", stderr: "incomplete results", message: "incomplete results" },
  { exitCode: 0, stdout: "42\ninvalid\n", stderr: "", message: "invalid process IDs" },
  { exitCode: 0, stdout: "0\n", stderr: "", message: "invalid process IDs" },
  { exitCode: 0, stdout: "1.5\n", stderr: "", message: "invalid process IDs" },
])("rejects uncertain listener discovery: %j", async (result) => {
  const discovery = listDaemonPids(1234, async () => result)
  await expect(discovery).rejects.toThrow("Cannot discover TCP listeners on port 1234")
  await expect(discovery).rejects.toThrow(result.message)
})

test("reports an unavailable lsof executable", async () => {
  await expect(
    listDaemonPids(1234, async () => {
      throw new Error("Executable not found: lsof")
    })
  ).rejects.toThrow("Cannot discover TCP listeners on port 1234: Executable not found: lsof")
})

test.each(["denied", "timeout"])("CLI fails when listener discovery is %s", async (scenario) => {
  const cwd = await temporary.create()
  const lsof = join(cwd, "lsof")
  await Bun.write(
    lsof,
    scenario === "denied"
      ? '#!/bin/sh\nprintf "permission denied\\n" >&2\nexit 1\n'
      : "#!/bin/sh\nexec /bin/sleep 10\n"
  )
  chmodSync(lsof, 0o755)
  const proc = Bun.spawn([process.execPath, indexPath, "daemon", "--restart", "--port", "1234"], {
    cwd,
    env: {
      ...process.env,
      HOME: cwd,
      PATH: `${cwd}:${process.env.PATH}`,
      SWIZ_DIRECT: "1",
      AI_TEST_NO_BACKEND: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 8000,
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  expect(await proc.exited).toBe(1)
  expect(stdout).toBe("")
  expect(stderr).toContain("Cannot discover TCP listeners on port 1234")
  expect(stderr).toContain(scenario === "denied" ? "permission denied" : "lsof exited")
}, 10_000)

test.each([
  0,
  -1,
  65536,
  1.5,
  Number.NaN,
])("rejects invalid port %s before querying", async (port) => {
  await expect(
    listDaemonPids(port, async () => {
      throw new Error("must not query")
    })
  ).rejects.toThrow("Invalid TCP listener port")
})

test("uses fresh listener identities and excludes self during forced retry", async () => {
  let queries = 0
  const signals: Array<[number, string | undefined]> = []
  const waits: number[] = []
  const stopped = await restartDaemonOnPort(1234, 999, {
    listPids: async () => {
      queries++
      return queries === 1 ? [101, 999] : queries < 8 ? [202, 999] : [999]
    },
    kill: (pid, signal) => {
      signals.push([pid, signal])
    },
    wait: async (ms) => {
      waits.push(ms)
    },
  })
  expect(stopped).toBe(1)
  expect(signals).toEqual([
    [101, undefined],
    [202, "SIGKILL"],
  ])
  expect(queries).toBe(8)
  expect(waits).toEqual(Array(6).fill(200))
})

test.each([1, 2, 8])("propagates discovery failure on query %s", async (failureAt) => {
  let queries = 0
  const signals: Array<[number, string | undefined]> = []
  await expect(
    restartDaemonOnPort(1234, 999, {
      listPids: async () => {
        if (++queries === failureAt) throw new Error("listener query failed")
        return [101, 999]
      },
      kill: (pid, signal) => {
        signals.push([pid, signal])
      },
      wait: async () => {},
    })
  ).rejects.toThrow("listener query failed")
  expect(signals).toEqual(
    failureAt === 1
      ? []
      : failureAt === 2
        ? [[101, undefined]]
        : [
            [101, undefined],
            [101, "SIGKILL"],
          ]
  )
})

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
  expect(await Bun.file(join(cwd, "lsof.log")).text()).toBe(
    "-nP -t +w -a -iTCP:1234 -sTCP:LISTEN\n"
  )
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
