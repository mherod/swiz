/**
 * Cross-platform TTS using native platform speech engines.
 * macOS: say, Linux: espeak-ng/espeak/spd-say, Windows: PowerShell SpeechSynthesizer
 *
 * Usage:
 *   bun speak.ts "text to speak"
 *   echo "text" | bun speak.ts
 *   bun speak.ts --diagnose          # show platform, backend, fallback info
 */

const platform = process.platform
const diagnose = process.argv.includes("--diagnose")

// Parse --voice and --speed flags
let voiceArg = ""
let speedArg = 0
const filteredArgs: string[] = []
const rawArgs = process.argv.slice(2)
for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i]
  if (arg === "--diagnose") continue
  if (arg === "--voice" && rawArgs[i + 1]) {
    voiceArg = rawArgs[++i]!
    continue
  }
  if (arg === "--speed" && rawArgs[i + 1]) {
    speedArg = parseInt(rawArgs[++i]!, 10) || 0
    continue
  }
  filteredArgs.push(arg!)
}

// Resolve text: CLI args first (excluding flags), then stdin
let text = filteredArgs.join(" ").trim()

if (!text && !diagnose) {
  const stdin = await new Response(Bun.stdin.stream()).text().catch(() => "")
  text = stdin.trim()
}

if (!text && !diagnose) {
  process.stderr.write('Usage: bun speak.ts "text to speak"\n')
  process.stderr.write('   or: echo "text" | bun speak.ts\n')
  process.stderr.write("   or: bun speak.ts --diagnose\n")
  process.exit(1)
}

/** Check if a binary exists on PATH. */
async function binaryExists(name: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", name], { stdout: "pipe", stderr: "pipe" })
    await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    await proc.exited
    return proc.exitCode === 0
  } catch {
    return false
  }
}

/** Safely spawn a command, returning false on failure. */
async function safeSpawn(cmd: string[]): Promise<boolean> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
    const [_stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    if (proc.exitCode !== 0) {
      process.stderr.write(`${cmd[0]} exited ${proc.exitCode}: ${stderr.trim()}\n`)
      return false
    }
    return true
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
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

// ── Diagnose mode ──────────────────────────────────────────────────

if (diagnose) {
  const diag: Record<string, any> = {
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
    diag.backend = null
    diag.reason = "scanning Linux TTS engines in preference order"
    diag.engines = []
    for (const engine of linuxEngines) {
      const found = await binaryExists(engine.name)
      ;(diag.engines as Array<Record<string, any>>).push({
        name: engine.name,
        found,
        install: engine.install,
      })
      if (found && !diag.backend) {
        diag.backend = engine.name
        diag.reason = `${engine.name} found on PATH`
      }
    }
    if (!diag.backend) {
      diag.reason = "no TTS engine found — install one of the listed engines"
    }
  }

  process.stdout.write(`${JSON.stringify(diag, null, 2)}\n`)
  process.exit(0)
}

// ── Speak ───────────────────────────────────────────────────────────

let ok = false

if (platform === "darwin") {
  const sayArgs = ["say"]
  if (voiceArg) sayArgs.push("-v", voiceArg)
  if (speedArg > 0) sayArgs.push("-r", String(speedArg))
  sayArgs.push(text)
  ok = await safeSpawn(sayArgs)
} else if (platform === "win32") {
  const escaped = text.replace(/'/g, "''")
  const escapedVoice = voiceArg.replace(/'/g, "''")
  const voiceLine = voiceArg ? `$synth.SelectVoice('${escapedVoice}');` : ""
  const rateLine = speedArg > 0 ? `$synth.Rate = ${Math.round((speedArg - 200) / 20)};` : ""
  ok = await safeSpawn([
    "powershell",
    "-NoProfile",
    "-Command",
    `Add-Type -AssemblyName System.Speech; $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer; ${voiceLine}${rateLine}$synth.Speak('${escaped}')`,
  ])
} else {
  for (const engine of linuxEngines) {
    if (await binaryExists(engine.name)) {
      const cmd = [engine.name]
      if (engine.name === "espeak-ng" || engine.name === "espeak") {
        if (voiceArg) cmd.push("-v", voiceArg)
        if (speedArg > 0) cmd.push("-s", String(speedArg))
      }
      cmd.push(text)
      ok = await safeSpawn(cmd)
      break
    }
  }

  if (!ok) {
    process.stderr.write("\nNo TTS engine found. Install one of:\n")
    for (const e of linuxEngines) {
      process.stderr.write(`  ${e.name}: ${e.install}\n`)
    }
  }
}

if (!ok) {
  process.stderr.write(
    `Text not spoken: "${text.slice(0, 200)}${text.length > 200 ? "..." : ""}"\n`
  )
  process.exit(1)
}
