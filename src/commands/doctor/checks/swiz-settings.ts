import { readSwizSettings } from "../../../settings.ts"
import { messageFromUnknownError } from "../../../utils/hook-json-helpers.ts"
import type { CheckResult, DiagnosticCheck } from "../types.ts"

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
    const msg = messageFromUnknownError(e)
    return {
      name: "Swiz settings",
      status: "fail",
      detail: msg,
    }
  }
}

export const swizSettingsCheck: DiagnosticCheck = {
  name: "swiz-settings",
  run: () => checkSwizSettings().then((r) => [r]),
}
