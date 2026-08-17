/**
 * Cross-platform TTS using native platform speech engines.
 * macOS: say, Linux: espeak-ng/espeak/spd-say, Windows: PowerShell SpeechSynthesizer
 *
 * Usage:
 *   bun speak.ts "text to speak"
 *   echo "text" | bun speak.ts
 *   bun speak.ts --diagnose          # show platform, backend, fallback info
 */

import { messageFromUnknownError } from "../src/utils/hook-json-helpers.ts"
import { spawnWithTimeout } from "../src/utils/process-utils.ts"

/** Check if a binary exists on PATH. */
export async function binaryExists(name: string, timeoutMs = 2_000): Promise<boolean> {
  try {
    const res = await spawnWithTimeout(["which", name], { timeoutMs })
    return res.exitCode === 0 && !res.timedOut
  } catch {
    return false
  }
}

/** Safely spawn a command, returning false on failure. */
export async function safeSpawn(cmd: string[], timeoutMs = 30_000): Promise<boolean> {
  try {
    const res = await spawnWithTimeout(cmd, { timeoutMs })
    if (res.timedOut) {
      process.stderr.write(`${cmd[0]} timed out after ${timeoutMs}ms\n`)
      return false
    }
    if (res.exitCode !== 0) {
      process.stderr.write(`${cmd[0]} exited ${res.exitCode}: ${res.stderr.trim()}\n`)
      return false
    }
    return true
  } catch (e: unknown) {
    const msg = messageFromUnknownError(e)
    process.stderr.write(`Failed to run ${cmd[0]}: ${msg}\n`)
    return false
  }
}

// ── Engine definitions ──────────────────────────────────────────────

const linuxEngines = [
  { name: "espeak-ng", install: "sudo apt install espeak-ng" },
  { name: "espeak", install: "sudo apt install espeak" },
  { name: "spd-say", install: "sudo apt install speech-dispatcher" },
]

export interface ParsedArgs {
  diagnose: boolean
  voiceArg: string
  speedArg: number
  text: string
}

export function parseCliArgs(argv: string[]): ParsedArgs {
  let voiceArg = ""
  let speedArg = 0
  const filteredArgs: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--diagnose") continue
    if (arg === "--voice" && argv[i + 1]) {
      voiceArg = argv[++i]!
      continue
    }
    if (arg === "--speed" && argv[i + 1]) {
      speedArg = parseInt(argv[++i]!, 10) || 0
      continue
    }
    filteredArgs.push(arg!)
  }
  return {
    diagnose: argv.includes("--diagnose"),
    voiceArg,
    speedArg,
    text: filteredArgs.join(" ").trim(),
  }
}

async function diagnoseLinux(): Promise<{
  backend: string | null
  reason: string
  engines: Array<{ name: string; found: boolean; install: string }>
}> {
  const engines: Array<{ name: string; found: boolean; install: string }> = []
  let backend: string | null = null
  let reason = "no TTS engine found — install one of the listed engines"

  for (const engine of linuxEngines) {
    const found = await binaryExists(engine.name)
    engines.push({ name: engine.name, found, install: engine.install })
    if (found && !backend) {
      backend = engine.name
      reason = `${engine.name} found on PATH`
    }
  }
  return { backend, reason, engines }
}

export async function runDiagnose(platform: string = process.platform): Promise<void> {
  const diag: Record<string, unknown> = {
    platform,
    arch: process.arch,
    bun: Bun.version,
  }

  if (platform === "darwin") {
    const hasSay = await binaryExists("say")
    diag.backend = hasSay ? "say" : null
    diag.reason = hasSay ? "macOS native say command found" : "say not found on PATH"
  } else if (platform === "win32") {
    diag.backend = "powershell SpeechSynthesizer"
    diag.reason = "Windows uses built-in System.Speech assembly"
  } else {
    const linuxDiag = await diagnoseLinux()
    diag.backend = linuxDiag.backend
    diag.reason = linuxDiag.reason
    diag.engines = linuxDiag.engines
  }

  process.stdout.write(`${JSON.stringify(diag, null, 2)}\n`)
}

async function speakDarwin(text: string, voiceArg: string, speedArg: number): Promise<boolean> {
  const sayArgs = ["say"]
  if (voiceArg) sayArgs.push("-v", voiceArg)
  if (speedArg > 0) sayArgs.push("-r", String(speedArg))
  sayArgs.push(text)
  return await safeSpawn(sayArgs)
}

async function speakWin32(text: string, voiceArg: string, speedArg: number): Promise<boolean> {
  const escaped = text.replace(/'/g, "''")
  const escapedVoice = voiceArg.replace(/'/g, "''")
  const voiceLine = voiceArg ? `$synth.SelectVoice('${escapedVoice}');` : ""
  const rateLine = speedArg > 0 ? `$synth.Rate = ${Math.round((speedArg - 200) / 20)};` : ""
  return await safeSpawn([
    "powershell",
    "-NoProfile",
    "-Command",
    `Add-Type -AssemblyName System.Speech; $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer; ${voiceLine}${rateLine}$synth.Speak('${escaped}')`,
  ])
}

async function speakLinux(text: string, voiceArg: string, speedArg: number): Promise<boolean> {
  for (const engine of linuxEngines) {
    if (await binaryExists(engine.name)) {
      const cmd = [engine.name]
      if (engine.name === "espeak-ng" || engine.name === "espeak") {
        if (voiceArg) cmd.push("-v", voiceArg)
        if (speedArg > 0) cmd.push("-s", String(speedArg))
      }
      cmd.push(text)
      return await safeSpawn(cmd)
    }
  }

  process.stderr.write("\nNo TTS engine found. Install one of:\n")
  for (const e of linuxEngines) {
    process.stderr.write(`  ${e.name}: ${e.install}\n`)
  }
  return false
}

export async function speakOnPlatform(
  platform: string,
  text: string,
  voiceArg: string,
  speedArg: number
): Promise<boolean> {
  if (platform === "darwin") return await speakDarwin(text, voiceArg, speedArg)
  if (platform === "win32") return await speakWin32(text, voiceArg, speedArg)
  return await speakLinux(text, voiceArg, speedArg)
}

export async function runSpeak(
  argv: string[] = process.argv.slice(2),
  stdinText?: string
): Promise<boolean> {
  const platform = process.platform
  const parsed = parseCliArgs(argv)

  if (parsed.diagnose) {
    await runDiagnose(platform)
    return true
  }

  let text = parsed.text
  if (!text) {
    if (stdinText !== undefined) {
      text = stdinText.trim()
    } else if (!process.stdin.isTTY) {
      const stdin = await new Response(Bun.stdin.stream()).text().catch(() => "")
      text = stdin.trim()
    }
  }

  if (!text) {
    process.stderr.write('Usage: bun speak.ts "text to speak"\n')
    process.stderr.write('   or: echo "text" | bun speak.ts\n')
    process.stderr.write("   or: bun speak.ts --diagnose\n")
    return false
  }

  const ok = await speakOnPlatform(platform, text, parsed.voiceArg, parsed.speedArg)
  if (!ok) {
    process.stderr.write(
      `Text not spoken: "${text.slice(0, 200)}${text.length > 200 ? "..." : ""}"\n`
    )
    return false
  }
  return true
}

if (import.meta.main) {
  const success = await runSpeak()
  if (!success) {
    process.exit(1)
  }
}
