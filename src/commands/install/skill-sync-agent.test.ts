import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { type LaunchAgentRuntime, SWIZ_SKILL_SYNC_LABEL } from "../../launch-agents.ts"
import { runCommandInProcess, useTempDir } from "../../utils/test-utils.ts"
import { skillCommand } from "../skill.ts"
import { buildSkillSyncLaunchAgentConfig } from "./skill-sync-agent.ts"

const temp = useTempDir("swiz-skill-sync-agent-")

/** In-memory launchd for one GUI domain: records every command it is asked to run. */
class FakeLaunchd implements LaunchAgentRuntime {
  readonly calls: string[][] = []
  loadedPlist: object | null = null
  registered = false

  async run(command: string[]) {
    this.calls.push(command)
    const [tool, verb] = command
    if (tool === "plutil") {
      const path = command.at(-1)!
      const exists = await Bun.file(path).exists()
      return exists && this.loadedPlist
        ? { exitCode: 0, stdout: JSON.stringify(this.loadedPlist), stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "no plist" }
    }
    if (verb === "print") {
      return this.registered
        ? { exitCode: 0, stdout: "pid = 4242\n", stderr: "" }
        : {
            exitCode: 113,
            stdout: "",
            stderr: `Could not find service "${SWIZ_SKILL_SYNC_LABEL}" in domain for user gui: 501`,
          }
    }
    if (verb === "bootstrap") this.registered = true
    if (verb === "bootout") this.registered = false
    return { exitCode: 0, stdout: "", stderr: "" }
  }

  kill(): void {
    throw new Error("the skill sync agent installer must not kill processes")
  }

  getUid(): number {
    return 501
  }

  verbs(): string[] {
    return this.calls.filter(([tool]) => tool === "launchctl").map(([, verb]) => verb!)
  }
}

async function skillHome() {
  const homeDir = await temp.create()
  for (const agent of ["claude", "codex"]) {
    await mkdir(join(homeDir, `.${agent}`, "skills"), { recursive: true })
  }
  const launchd = new FakeLaunchd()
  const trashed: string[] = []
  const launchAgent = {
    homeDir,
    platform: "darwin" as const,
    runtime: launchd,
    projectRoot: "/opt/swiz",
    bunPath: "/opt/bun/bin/bun",
    trashPath: async (path: string) => {
      trashed.push(path)
      return true
    },
  }
  const run = (args: string[]) =>
    runCommandInProcess(skillCommand, args, {
      commandOptions: { launchAgent },
      cwd: homeDir,
      env: { HOME: homeDir },
    })
  const plistPath = join(homeDir, "Library/LaunchAgents", `${SWIZ_SKILL_SYNC_LABEL}.plist`)
  return { homeDir, launchd, launchAgent, trashed, run, plistPath }
}

describe("swiz skill --sync-watch --install", () => {
  test("installs a login agent that runs the watch with the given arguments", async () => {
    const home = await skillHome()

    const { stdout, exitCode } = await home.run([
      "--sync-watch",
      "--agents",
      "claude,codex",
      "--install",
    ])

    expect(exitCode).toBe(0)
    expect(stdout).toContain(`${SWIZ_SKILL_SYNC_LABEL}: installed and started`)
    expect(stdout).toContain("Runs at login: swiz skill --sync-watch --agents claude,codex")
    expect(home.launchd.verbs()).toContain("bootstrap")
    const plist = await Bun.file(home.plistPath).text()
    expect(plist).toContain("<string>--sync-watch</string>")
    expect(plist).toContain("<string>claude,codex</string>")
    expect(plist).toContain("<key>RunAtLoad</key>\n<true/>")
    expect(plist).toContain("<key>KeepAlive</key>\n<true/>")
  })

  test("re-running with the same arguments leaves a running agent alone", async () => {
    const home = await skillHome()
    const args = ["--sync-watch", "--agents", "claude,codex", "--install"]
    await home.run(args)
    home.launchd.loadedPlist = buildSkillSyncLaunchAgentConfig(
      ["--agents", "claude,codex"],
      home.launchAgent
    )
    home.launchd.calls.length = 0

    const { stdout } = await home.run(args)

    expect(stdout).toContain("already installed and running")
    expect(home.launchd.verbs()).not.toContain("bootstrap")
    expect(home.launchd.verbs()).not.toContain("bootout")
  })

  test("--dry-run previews without writing and is not persisted into the agent", async () => {
    const home = await skillHome()

    const { stdout } = await home.run([
      "--sync-watch",
      "--agents",
      "claude,codex",
      "--install",
      "--dry-run",
    ])

    expect(stdout).toContain("would be installed and started")
    expect(stdout).toContain("Runs at login: swiz skill --sync-watch --agents claude,codex\n")
    expect(await Bun.file(home.plistPath).exists()).toBe(false)
    expect(home.launchd.verbs()).not.toContain("bootstrap")
  })

  test("invalid watch arguments fail at install time instead of at the next login", async () => {
    const home = await skillHome()

    const { stderr, exitCode } = await home.run([
      "--sync-watch",
      "--agents",
      "claude,notanagent",
      "--install",
    ])

    expect(exitCode).not.toBe(0)
    expect(stderr).toContain("Unknown agent: notanagent")
    expect(await Bun.file(home.plistPath).exists()).toBe(false)
  })

  test("--uninstall stops the agent and moves its plist to the Trash", async () => {
    const home = await skillHome()
    await home.run(["--sync-watch", "--agents", "claude,codex", "--install"])

    const { stdout, exitCode } = await home.run(["--sync-watch", "--uninstall"])

    expect(exitCode).toBe(0)
    expect(stdout).toContain(`${SWIZ_SKILL_SYNC_LABEL}: stopped and removed`)
    expect(home.launchd.verbs()).toContain("bootout")
    expect(home.trashed).toEqual([home.plistPath])
  })

  test("--install outside --sync-watch is rejected", async () => {
    const home = await skillHome()
    const { stderr, exitCode } = await home.run(["--install"])
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain("--install and --uninstall are only valid with --sync-watch.")
  })
})
