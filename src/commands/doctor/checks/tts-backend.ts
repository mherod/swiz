import type { DiagnosticCheck } from "../types.ts"
import { whichExists } from "../utils.ts"

export const ttsBackendCheck: DiagnosticCheck = {
  name: "tts-backend",
  async run() {
    const platform = process.platform

    if (platform === "darwin") {
      const sayPath = await whichExists("say")
      if (sayPath) {
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
      const enginePath = await whichExists(engine)
      if (enginePath) {
        return { name: "TTS backend", status: "pass", detail: engine }
      }
    }

    return {
      name: "TTS backend",
      status: "warn",
      detail: "no TTS engine found — install espeak-ng, espeak, or spd-say",
    }
  },
}
