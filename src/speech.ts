/**
 * Text-to-speech helper for hooks and commands.
 * Extracted from hooks/hook-utils.ts so src/commands can import without
 * crossing the src → hooks dependency boundary.
 */

import { dirname, join } from "node:path"
import { getEffectiveSwizSettings, readSwizSettings } from "./settings.ts"
import { speakCooldownPath, speakLockPath, speakPositionPath } from "./temp-paths.ts"
import { withFileLock } from "./utils/file-lock.ts"
import { streamJsonlLines, tryParseJsonLine } from "./utils/jsonl.ts"

const DEFAULT_COOLDOWN_SECONDS = 10

async function checkCooldown(sessionId: string, cooldownSeconds: number): Promise<boolean> {
  if (cooldownSeconds <= 0) return true
  const cooldownFile = speakCooldownPath(sessionId)
  try {
    if (await Bun.file(cooldownFile).exists()) {
      const lastRun = parseInt((await Bun.file(cooldownFile).text()).trim(), 10)
      const age = Date.now() - lastRun
      if (age < cooldownSeconds * 1000) return false
    }
    await Bun.write(cooldownFile, String(Date.now()))
  } catch {
    // Ignore cooldown errors — fail open
  }
  return true
}

async function readLastSpokenPosition(posFile: string): Promise<number> {
  try {
    if (await Bun.file(posFile).exists()) {
      return parseInt((await Bun.file(posFile).text()).trim(), 10) || 0
    }
  } catch {
    // Corrupted pos file — start from 0
  }
  return 0
}

interface AssistantBlock {
  type?: string
  text?: string
}

interface AssistantEntry {
  type?: string
  message?: { content?: AssistantBlock[] }
}

function collectAssistantText(entry: AssistantEntry | undefined, texts: string[]): void {
  if (!entry || entry.type !== "assistant") return
  for (const block of entry.message?.content ?? []) {
    if (block.type === "text" && block.text) {
      texts.push(block.text)
    }
  }
}

async function extractNewAssistantText(
  transcriptPath: string,
  lastPos: number
): Promise<{ texts: string[]; totalLines: number }> {
  const texts: string[] = []
  let totalLines = 0
  for await (const line of streamJsonlLines(transcriptPath)) {
    if (!line.trim()) continue
    totalLines++
    if (totalLines <= lastPos) continue
    const entry = tryParseJsonLine(line) as AssistantEntry | undefined
    collectAssistantText(entry, texts)
  }
  return { texts, totalLines }
}

async function resolveTranscriptNewText(
  sessionId: string,
  transcriptPath: string
): Promise<string> {
  if (!(await Bun.file(transcriptPath).exists())) return ""
  const posFile = speakPositionPath(sessionId)
  const lastPos = await readLastSpokenPosition(posFile)
  const { texts, totalLines } = await extractNewAssistantText(transcriptPath, lastPos)
  if (totalLines <= lastPos) return ""
  await Bun.write(posFile, String(totalLines))
  return texts.join(" ").replace(/\s+/g, " ").trim()
}

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

  const canProceed = await checkCooldown(sessionId, cooldownSeconds)
  if (!canProceed) return

  const hasMessage = typeof message === "string" && message.trim().length > 0
  const newText = hasMessage
    ? message!.trim()
    : await resolveTranscriptNewText(sessionId, transcriptPath)

  if (newText.length < 5) return

  const truncated = newText.slice(0, 500)
  const lockFile = speakLockPath(sessionId)

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
