#!/usr/bin/env bun
// PreCompact hook: Speak a narration before context compaction begins.

import { getEffectiveSwizSettings, readSwizSettings } from "../src/settings.ts"
import { spawnSpeak } from "./utils/hook-utils.ts"

async function main(): Promise<void> {
  const input = await Bun.stdin.json().catch(() => null)
  const sessionId: string = ((input as Record<string, unknown>)?.session_id as string) ?? ""

  const rawSettings = await readSwizSettings()
  const settings = getEffectiveSwizSettings(rawSettings, sessionId || null)
  if (!settings.speak) return

  await spawnSpeak("Just a moment while I gather my thoughts", settings)
}

if (import.meta.main) void main()
