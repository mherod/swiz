import { dirname, join } from "node:path"
import { executeDispatch } from "../dispatch/execute.ts"
import type { Command } from "../types.ts"

const LABEL = "com.swiz.daemon"
const PLIST_PATH = join(process.env.HOME ?? "", "Library/LaunchAgents", `${LABEL}.plist`)

function buildPlist(port: number): string {
  const bunPath = Bun.which("bun") ?? "/opt/homebrew/bin/bun"
  const projectRoot = dirname(Bun.main)
  const indexPath = join(projectRoot, "index.ts")
  const daemonTs = join(projectRoot, "src", "commands", "daemon.ts")

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>--watch</string>
    <string>${indexPath}</string>
    <string>daemon</string>
    <string>--port</string>
    <string>${port}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${projectRoot}</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/tmp/swiz-daemon.log</string>

  <key>StandardErrorPath</key>
  <string>/tmp/swiz-daemon.log</string>

  <key>WatchPaths</key>
  <array>
    <string>${daemonTs}</string>
    <string>${indexPath}</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>`
}

async function install(port: number) {
  const plist = buildPlist(port)
  await Bun.write(PLIST_PATH, plist)
  console.log(`Wrote ${PLIST_PATH}`)

  const load = Bun.spawn(["launchctl", "load", PLIST_PATH], {
    stdout: "inherit",
    stderr: "inherit",
  })
  await load.exited
  if (load.exitCode !== 0) {
    throw new Error("launchctl load failed")
  }
  console.log(`Loaded ${LABEL}`)
}

async function uninstall() {
  const load = Bun.spawn(["launchctl", "unload", PLIST_PATH], {
    stdout: "inherit",
    stderr: "inherit",
  })
  await load.exited

  const file = Bun.file(PLIST_PATH)
  if (await file.exists()) {
    const rm = Bun.spawn(["trash", PLIST_PATH], {
      stdout: "inherit",
      stderr: "inherit",
    })
    await rm.exited
    console.log(`Removed ${PLIST_PATH}`)
  }
  console.log(`Unloaded ${LABEL}`)
}

export const daemonCommand: Command = {
  name: "daemon",
  description: "Run a background web server",
  usage: "swiz daemon [--port <port>] [--install] [--uninstall]",
  options: [
    { flags: "--port <port>", description: "Port to listen on (default: 7943)" },
    { flags: "--install", description: "Install as a LaunchAgent" },
    { flags: "--uninstall", description: "Uninstall the LaunchAgent" },
  ],
  async run(args) {
    const portIndex = args.indexOf("--port")
    const port = portIndex !== -1 ? Number(args[portIndex + 1]) : 7943

    if (args.includes("--install")) {
      await install(port)
      return
    }

    if (args.includes("--uninstall")) {
      await uninstall()
      return
    }

    const server = Bun.serve({
      port,
      routes: {
        "/health": new Response("ok"),
      },
      async fetch(req) {
        const url = new URL(req.url)

        if (url.pathname === "/dispatch" && req.method === "POST") {
          const canonicalEvent = url.searchParams.get("event")
          const hookEventName = url.searchParams.get("hookEventName") ?? canonicalEvent
          if (!canonicalEvent || !hookEventName) {
            return Response.json({ error: "Missing required query param: event" }, { status: 400 })
          }

          const payloadStr = await req.text()
          const result = await executeDispatch({ canonicalEvent, hookEventName, payloadStr })
          return Response.json(result.response)
        }

        return new Response("Not Found", { status: 404 })
      },
    })

    console.log(`Daemon listening on ${server.url}`)
  },
}
