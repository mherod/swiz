import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { getAgent } from "../src/agents.ts"
import { mergeConfig } from "../src/commands/install/config-helpers.ts"
import { buildProposedAgentSettings } from "../src/commands/install/settings-helpers.ts"
import {
  isSessionstartSelfHealPaused,
  sessionstartSelfHealPausedPath,
  setAgentSelfHealEnabled,
} from "../src/sessionstart-self-heal-state.ts"
import { useTempDir } from "../src/utils/test-utils.ts"
import { evaluateSessionstartSelfHeal } from "./sessionstart-self-heal.ts"

const temp = useTempDir("scoped-self-heal-")
const swizRoot = dirname(dirname(import.meta.path))
const payload = {
  session_id: "self-heal-test",
  cwd: swizRoot,
  source: "startup",
  _agent: "codex",
  _env: {},
}

describe("provider scoped self-heal", () => {
  test("Codex reinstall overrides only its own pause and preserves global uninstall", async () => {
    const homeDir = await temp.create()
    const marker = sessionstartSelfHealPausedPath(homeDir)
    await mkdir(dirname(marker), { recursive: true })
    await Bun.write(marker, "")
    await setAgentSelfHealEnabled("codex", true, homeDir)
    expect(await isSessionstartSelfHealPaused("codex", homeDir)).toBe(false)
    expect(await isSessionstartSelfHealPaused("claude", homeDir)).toBe(true)
    const called: string[] = []
    await evaluateSessionstartSelfHeal(payload, {
      homeDir,
      install: (_root, agent) => {
        called.push(agent.id)
        return Promise.resolve(true)
      },
    })
    expect(called).toEqual(["codex"])
    expect(await Bun.file(marker).exists()).toBe(true)
    expect(await Bun.file(join(homeDir, ".local/share/swiz/manifest-hash-codex")).exists()).toBe(
      true
    )
    expect(await Bun.file(join(homeDir, ".local/share/swiz/manifest-hash-claude")).exists()).toBe(
      false
    )
  })
  test("uninstall and malformed per-agent state prevent automatic reinstall", async () => {
    const homeDir = await temp.create()
    await setAgentSelfHealEnabled("codex", false, homeDir)
    const install = () => Promise.reject<boolean>(new Error("must not install"))
    expect(await evaluateSessionstartSelfHeal(payload, { homeDir, install })).toEqual({})
    await Bun.write(join(homeDir, ".local/share/swiz/self-heal-codex.json"), "broken")
    expect(await evaluateSessionstartSelfHeal(payload, { homeDir, install })).toEqual({})
  })
  test("unknown and plugin callers never trigger a broad install", async () => {
    const install = () => Promise.reject<boolean>(new Error("must not install"))
    expect(
      await evaluateSessionstartSelfHeal({ ...payload, _agent: undefined }, { install })
    ).toEqual({})
    expect(
      await evaluateSessionstartSelfHeal({ ...payload, _env: { SWIZ_PLUGIN: "1" } }, { install })
    ).toEqual({})
  })
  test("reads Codex registrations and handles --agent instead of checking Claude", async () => {
    const homeDir = await temp.create()
    const agent = getAgent("codex")!
    const path = join(homeDir, ".codex/hooks.json")
    await mkdir(dirname(path), { recursive: true })
    await Bun.write(path, buildProposedAgentSettings({}, agent, mergeConfig(agent, {})))
    const hashPath = join(homeDir, ".local/share/swiz/manifest-hash-codex")
    await mkdir(dirname(hashPath), { recursive: true })
    const hash = createHash("sha256")
      .update(await Bun.file(join(swizRoot, "src/manifest.ts")).text())
      .digest("hex")
    await Bun.write(hashPath, hash)
    const called: string[] = []
    const install = (_root: string, target: typeof agent) => {
      called.push(target.id)
      return Promise.resolve(true)
    }
    expect(await evaluateSessionstartSelfHeal(payload, { homeDir, install })).toEqual({})
    expect(called).toEqual([])
    await Bun.write(path, '{"hooks":{}}')
    await evaluateSessionstartSelfHeal(payload, { homeDir, install })
    expect(called).toEqual(["codex"])
  })
  test("backs up the previous agent choice", async () => {
    const homeDir = await temp.create()
    await setAgentSelfHealEnabled("codex", true, homeDir)
    await setAgentSelfHealEnabled("codex", false, homeDir)
    expect(
      await Bun.file(join(homeDir, ".local/share/swiz/self-heal-codex.json.bak")).json()
    ).toEqual({ enabled: true })
  })
})
