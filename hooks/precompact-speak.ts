#!/usr/bin/env bun

/**
 * PreCompact hook: Speak a narration before context compaction begins.
 *
 * Dual-mode: exports a SwizSessionHook for inline dispatch and remains
 * executable as a standalone script for backwards compatibility and testing.
 */

import type { SwizSessionHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { narrateSession } from "../src/speech.ts"

const precompactSpeak: SwizSessionHook = {
  name: "precompact-speak",
  event: "preCompact",
  timeout: 30,

  async run(input) {
    const transcriptPath: string = (input.transcript_path as string) ?? ""
    const sessionId: string = (input.session_id as string) ?? ""
    await narrateSession({
      sessionId,
      transcriptPath,
      message: "Just a moment while I gather my thoughts",
      cooldownSeconds: 0, // Compaction is a discrete event; always speak if requested
    })
    return {}
  },
}

export default precompactSpeak

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) await runSwizHookAsMain(precompactSpeak)
