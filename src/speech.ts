/**
 * Text-to-speech helper for hooks and commands.
 * Extracted from hooks/hook-utils.ts so src/commands can import without
 * crossing the src → hooks dependency boundary.
 */

import { dirname, join } from "node:path"

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
  if (settings.narratorVoice) speakArgs.push("--voice", settings.narratorVoice)
  if (settings.narratorSpeed > 0) speakArgs.push("--speed", String(settings.narratorSpeed))
  try {
    const proc = Bun.spawn(speakArgs, {
      stdin: new Response(text).body!,
      stderr: "pipe",
    })
    await new Response(proc.stderr).text()
    await proc.exited
  } catch {
    // Silent failure — TTS errors must not affect hook or command behaviour
  }
}
