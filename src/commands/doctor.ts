import { dirname, join } from "node:path"
import { AGENTS, type AgentDef } from "../agents.ts"
import { manifest } from "../manifest.ts"
import { readSwizSettings } from "../settings.ts"
import type { Command } from "../types.ts"

const SWIZ_ROOT = dirname(Bun.main)
const HOOKS_DIR = join(SWIZ_ROOT, "hooks")

const BOLD = "\x1b[1m"
const GREEN = "\x1b[32m"
const RED = "\x1b[31m"
const YELLOW = "\x1b[33m"
const DIM = "\x1b[2m"
const RESET = "\x1b[0m"

const PASS = `${GREEN}✓${RESET}`
const FAIL = `${RED}✗${RESET}`
const WARN = `${YELLOW}!${RESET}`

interface CheckResult {
  name: string
  status: "pass" | "warn" | "fail"
  detail: string
}

// ─── Individual checks ──────────────────────────────────────────────────────

async function checkBun(): Promise<CheckResult> {
  return {
    name: "Bun runtime",
    status: "pass",
    detail: `v${Bun.version}`,
  }
}

function checkAgentBinary(agent: AgentDef): CheckResult {
  const proc = Bun.spawnSync(["which", agent.binary])
  const found = proc.exitCode === 0
  const path = found ? new TextDecoder().decode(proc.stdout).trim() : null

  return {
    name: `${agent.name} binary`,
    status: found ? "pass" : "warn",
    detail: found ? path! : `"${agent.binary}" not found on PATH`,
  }
}

async function checkAgentSettings(agent: AgentDef): Promise<CheckResult> {
  const file = Bun.file(agent.settingsPath)
  const exists = await file.exists()

  if (!exists) {
    return {
      name: `${agent.name} settings`,
      status: "warn",
      detail: `${agent.settingsPath} not found`,
    }
  }

  try {
    await file.json()
    return {
      name: `${agent.name} settings`,
      status: "pass",
      detail: agent.settingsPath,
    }
  } catch {
    return {
      name: `${agent.name} settings`,
      status: "fail",
      detail: `${agent.settingsPath} exists but is malformed JSON`,
    }
  }
}

async function checkHookScripts(): Promise<CheckResult> {
  const allFiles = new Set<string>()
  for (const group of manifest) {
    for (const hook of group.hooks) {
      allFiles.add(hook.file)
    }
  }

  const missing: string[] = []
  for (const file of allFiles) {
    const path = join(HOOKS_DIR, file)
    if (!(await Bun.file(path).exists())) {
      missing.push(file)
    }
  }

  if (missing.length === 0) {
    return {
      name: "Hook scripts",
      status: "pass",
      detail: `all ${allFiles.size} manifest scripts found in hooks/`,
    }
  }

  return {
    name: "Hook scripts",
    status: "fail",
    detail: `${missing.length} missing: ${missing.join(", ")}`,
  }
}

async function checkGhAuth(): Promise<CheckResult> {
  const whichProc = Bun.spawnSync(["which", "gh"])
  if (whichProc.exitCode !== 0) {
    return {
      name: "GitHub CLI auth",
      status: "warn",
      detail: "gh not installed — some hooks require it",
    }
  }

  const proc = Bun.spawn(["gh", "auth", "status"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited

  if (proc.exitCode === 0) {
    const output = (stdout + stderr).trim()
    const accountMatch = output.match(/Logged in to .+ account (\S+)/)
    const account = accountMatch?.[1] ?? "authenticated"
    return {
      name: "GitHub CLI auth",
      status: "pass",
      detail: account,
    }
  }

  return {
    name: "GitHub CLI auth",
    status: "fail",
    detail: "not authenticated — run: gh auth login",
  }
}

async function checkTtsBackend(): Promise<CheckResult> {
  const platform = process.platform

  if (platform === "darwin") {
    const proc = Bun.spawnSync(["which", "say"])
    if (proc.exitCode === 0) {
      return { name: "TTS backend", status: "pass", detail: "macOS say" }
    }
    return { name: "TTS backend", status: "warn", detail: "macOS say not found" }
  }

  if (platform === "win32") {
    return { name: "TTS backend", status: "pass", detail: "PowerShell SpeechSynthesizer" }
  }

  // Linux: check for espeak-ng, espeak, spd-say
  const linuxEngines = ["espeak-ng", "espeak", "spd-say"]
  for (const engine of linuxEngines) {
    const proc = Bun.spawnSync(["which", engine])
    if (proc.exitCode === 0) {
      return { name: "TTS backend", status: "pass", detail: engine }
    }
  }

  return {
    name: "TTS backend",
    status: "warn",
    detail: "no TTS engine found — install espeak-ng, espeak, or spd-say",
  }
}

async function checkSwizSettings(): Promise<CheckResult> {
  try {
    const settings = await readSwizSettings({ strict: true })
    const keys = Object.keys(settings).filter((k) => k !== "sessions")
    return {
      name: "Swiz settings",
      status: "pass",
      detail: keys
        .map((k) => `${k}=${JSON.stringify(settings[k as keyof typeof settings])}`)
        .join(", "),
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      name: "Swiz settings",
      status: "fail",
      detail: msg,
    }
  }
}

// ─── Runner ─────────────────────────────────────────────────────────────────

function printResult(result: CheckResult): void {
  const icon = result.status === "pass" ? PASS : result.status === "warn" ? WARN : FAIL
  const detailColor = result.status === "fail" ? RED : result.status === "warn" ? YELLOW : DIM
  console.log(`  ${icon} ${BOLD}${result.name}${RESET}  ${detailColor}${result.detail}${RESET}`)
}

export const doctorCommand: Command = {
  name: "doctor",
  description: "Check environment health and prerequisites",
  usage: "swiz doctor",
  async run() {
    console.log(`\n  ${BOLD}swiz doctor${RESET}\n`)

    const results: CheckResult[] = []

    // Core runtime
    results.push(await checkBun())

    // Agent binaries and settings
    for (const agent of AGENTS) {
      results.push(checkAgentBinary(agent))
      results.push(await checkAgentSettings(agent))
    }

    // Hook scripts
    results.push(await checkHookScripts())

    // GitHub CLI
    results.push(await checkGhAuth())

    // TTS
    results.push(await checkTtsBackend())

    // Swiz settings
    results.push(await checkSwizSettings())

    for (const result of results) {
      printResult(result)
    }

    const failures = results.filter((r) => r.status === "fail")
    const warnings = results.filter((r) => r.status === "warn")
    const passes = results.filter((r) => r.status === "pass")

    console.log()
    console.log(
      `  ${GREEN}${passes.length} passed${RESET}` +
        (warnings.length > 0 ? `, ${YELLOW}${warnings.length} warnings${RESET}` : "") +
        (failures.length > 0 ? `, ${RED}${failures.length} failed${RESET}` : "")
    )
    console.log()

    if (failures.length > 0) {
      throw new Error(
        `${failures.length} check(s) failed:\n` +
          failures.map((f) => `  - ${f.name}: ${f.detail}`).join("\n")
      )
    }
  },
}
