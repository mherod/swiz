#!/usr/bin/env bun
/**
 * PreCompact hook: Speak a narration before context compaction begins.
 *
 * Dual-mode: exports a SwizSessionHook for inline dispatch and remains
 * executable as a standalone script for backwards compatibility and testing.
 */

import { runSwizHookAsMain, type SwizSessionHook } from "../src/SwizHook.ts"
import type { EffectiveSwizSettings } from "../src/settings"
import { spawnSpeak } from "../src/speech.ts"

const precompactSpeak: SwizSessionHook = {
  name: "precompact-speak",
  event: "preCompact",
  timeout: 10,

  async run(input) {
    const settings = input._effectiveSettings as unknown as EffectiveSwizSettings | undefined
    if (!settings?.speak) return {}

    await spawnSpeak("Just a moment while I gather my thoughts", settings)
    return {}
  },
}

export default precompactSpeak

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) await runSwizHookAsMain(precompactSpeak)
