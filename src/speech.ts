/**
 * Text-to-speech helper for hooks and commands.
 * Extracted from hooks/hook-utils.ts so src/commands can import without
 * crossing the src → hooks dependency boundary.
 */

import { dirname, join } from "node:path"
import { getEffectiveSwizSettings, readSwizSettings } from "./settings.ts"
import { speakCooldownPath, speakLockPath, speakPositionPath } from "./temp-paths.ts"
import { withFileLock } from "./utils/file-lock.ts"
import { splitJsonlLines, tryParseJsonLine } from "./utils/jsonl.ts"

const DEFAULT_COOLDOWN_SECONDS = 10

/**
 * Orchestrate incremental narration for a session.
 * Handles incremental text detection, PID-aware locking, and TTS spawning.
 */
export async function narrateSession(payload: {
  sessionId: string
  transcriptPath: string
  message?: string
  cooldownSeconds?: number
}): Promise<void> {
  const { sessionId, transcriptPath, message, cooldownSeconds = DEFAULT_COOLDOWN_SECONDS } = payload
  if (!sessionId) return

  const rawSettings = await readSwizSettings()
  const settings = getEffectiveSwizSettings(rawSettings, sessionId)
  if (!settings.speak) return

  // Check cooldown if requested
  if (cooldownSeconds > 0) {
    const cooldownFile = speakCooldownPath(sessionId)
    try {
      if (await Bun.file(cooldownFile).exists()) {
        const lastRun = parseInt((await Bun.file(cooldownFile).text()).trim(), 10)
        const age = Date.now() - lastRun
        if (age < cooldownSeconds * 1000) return
      }
      await Bun.write(cooldownFile, String(Date.now()))
    } catch {
      // Ignore cooldown errors — fail open
    }
  }

  const hasMessage = typeof message === "string" && message.trim().length > 0
  if (!hasMessage && !(await Bun.file(transcriptPath).exists())) return

  const lockFile = speakLockPath(sessionId)

  let newText = ""

  if (hasMessage) {
    newText = message!.trim()
  } else {
    const posFile = speakPositionPath(sessionId)
    let lastPos = 0
    try {
      if (await Bun.file(posFile).exists()) {
        lastPos = parseInt((await Bun.file(posFile).text()).trim(), 10) || 0
      }
    } catch {
      // Corrupted pos file — start from 0
    }

    const lines = splitJsonlLines(await Bun.file(transcriptPath).text())
    const totalLines = lines.length

    if (totalLines <= lastPos) return

    const newLines = lines.slice(lastPos)
    const texts: string[] = []

    for (const line of newLines) {
      const entry = tryParseJsonLine(line) as
        | {
            type?: string
            message?: { content?: Array<{ type?: string; text?: string }> }
          }
        | undefined
      if (!entry || entry.type !== "assistant") continue
      for (const block of entry.message?.content ?? []) {
        if (block.type === "text" && block.text) {
          texts.push(block.text)
        }
      }
    }

    await Bun.write(posFile, String(totalLines))
    newText = texts.join(" ").replace(/\s+/g, " ").trim()
  }

  if (newText.length < 5) return

  const truncated = newText.slice(0, 500)

  try {
    await withFileLock(lockFile, async () => {
      await spawnSpeak(truncated, settings)
    })
  } catch {
    // Lock acquisition failed — silent skip
  }
}

/**
 * Spawn the speak.ts script to narrate text via macOS TTS.
 * Errors are silently swallowed — TTS must not affect hook or command behaviour.
 */
export async function spawnSpeak(
  text: string,
  settings: { narratorVoice: string; narratorSpeed: number },
  speakScriptPath?: string
): Promise<void> {
  const scriptPath = speakScriptPath ?? join(dirname(import.meta.path), "../hooks/speak.ts")
  const speakArgs = ["bun", scriptPath]
  if (settings.narratorVoice) {
    speakArgs.push("--voice", settings.narratorVoice)
  }
  if (settings.narratorSpeed > 0) {
    speakArgs.push("--speed", String(settings.narratorSpeed))
  }
  // Strip control characters and excessive whitespace
  const CTRL_RE = new RegExp(
    `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}]`,
    "g"
  )
  const sanitized = text.replace(CTRL_RE, "").replace(/\s+/g, " ").trim()
  if (!sanitized) return

  try {
    const proc = Bun.spawn(speakArgs, {
      stdin: new Response(sanitized).body!,
      stdout: "pipe",
      stderr: "pipe",
    })
    await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    await proc.exited
  } catch {
    // Silent failure — TTS errors must not affect hook or command behaviour
  }
}
