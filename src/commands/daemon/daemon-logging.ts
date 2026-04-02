import { appendFile } from "node:fs/promises"
import { stderrLog } from "../../debug.ts"
import { swizPseudoHookLogPath } from "../../temp-paths.ts"

export async function logPseudoHook(message: string): Promise<void> {
  try {
    const timestamp = new Date().toISOString()
    await appendFile(swizPseudoHookLogPath(), `[${timestamp}] ${message}\n`)
  } catch (err) {
    stderrLog("pseudo-hook logging", `Failed to log pseudo-hook: ${err}`)
  }
}
