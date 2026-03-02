import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"

export interface SessionSwizSettings {
  autoContinue: boolean
}

export interface SwizSettings {
  autoContinue: boolean
  pushGate: boolean
  sandboxedEdits: boolean
  sessions: Record<string, SessionSwizSettings>
}

export interface EffectiveSwizSettings {
  autoContinue: boolean
  pushGate: boolean
  sandboxedEdits: boolean
  source: "global" | "session"
}

export const DEFAULT_SETTINGS: SwizSettings = {
  autoContinue: true,
  pushGate: false,
  sandboxedEdits: true,
  sessions: {},
}

interface ReadOptions {
  home?: string | undefined
  strict?: boolean | undefined
}

interface WriteOptions {
  home?: string | undefined
}

function cloneDefaults(): SwizSettings {
  return { ...DEFAULT_SETTINGS, sessions: { ...DEFAULT_SETTINGS.sessions } }
}

function normalizeSessionSettings(value: unknown): SessionSwizSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const obj = value as Record<string, unknown>
  if (typeof obj.autoContinue !== "boolean") return null
  return { autoContinue: obj.autoContinue }
}

function normalizeSettings(value: unknown): SwizSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return cloneDefaults()
  const obj = value as Record<string, unknown>
  const rawSessions = obj.sessions
  const sessions: Record<string, SessionSwizSettings> = {}

  if (rawSessions && typeof rawSessions === "object" && !Array.isArray(rawSessions)) {
    for (const [sessionId, sessionValue] of Object.entries(rawSessions)) {
      const normalized = normalizeSessionSettings(sessionValue)
      if (normalized) sessions[sessionId] = normalized
    }
  }

  return {
    autoContinue:
      typeof obj.autoContinue === "boolean" ? obj.autoContinue : DEFAULT_SETTINGS.autoContinue,
    pushGate: typeof obj.pushGate === "boolean" ? obj.pushGate : DEFAULT_SETTINGS.pushGate,
    sandboxedEdits:
      typeof obj.sandboxedEdits === "boolean"
        ? obj.sandboxedEdits
        : DEFAULT_SETTINGS.sandboxedEdits,
    sessions,
  }
}

export function getSwizSettingsPath(home = process.env.HOME): string | null {
  if (!home) return null
  return join(home, ".swiz", "settings.json")
}

export async function readSwizSettings(options: ReadOptions = {}): Promise<SwizSettings> {
  const path = getSwizSettingsPath(options.home)
  if (!path) return cloneDefaults()

  const file = Bun.file(path)
  if (!(await file.exists())) return cloneDefaults()

  try {
    return normalizeSettings(await file.json())
  } catch (error) {
    if (options.strict) {
      throw new Error(`Failed to parse swiz settings at ${path}: ${String(error)}`)
    }
    return cloneDefaults()
  }
}

export function getEffectiveSwizSettings(
  settings: SwizSettings,
  sessionId?: string | null
): EffectiveSwizSettings {
  if (sessionId && settings.sessions[sessionId]) {
    return {
      autoContinue: settings.sessions[sessionId]!.autoContinue,
      pushGate: settings.pushGate,
      sandboxedEdits: settings.sandboxedEdits,
      source: "session",
    }
  }
  return {
    autoContinue: settings.autoContinue,
    pushGate: settings.pushGate,
    sandboxedEdits: settings.sandboxedEdits,
    source: "global",
  }
}

export async function writeSwizSettings(
  settings: SwizSettings,
  options: WriteOptions = {}
): Promise<string> {
  const path = getSwizSettingsPath(options.home)
  if (!path) throw new Error("HOME is not set; cannot write swiz settings.")

  await mkdir(dirname(path), { recursive: true })
  await Bun.write(path, `${JSON.stringify(normalizeSettings(settings), null, 2)}\n`)
  return path
}
