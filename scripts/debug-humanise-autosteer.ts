/**
 * Debug: measure latency and inspect output quality of humaniseAutoSteerMessage().
 *
 * Answers two questions empirically:
 *   1. How long does the inline LLM rewrite add to a scheduleAutoSteer() call?
 *      (relevant because PreToolUse gates await scheduleAutoSteer before returning)
 *   2. Do the humanised paragraphs read naturally AND preserve concrete
 *      instructions / file paths / commands?
 *
 * Run: bun scripts/debug-humanise-autosteer.ts
 * Provider is auto-selected (OpenRouter → Claude CLI → Gemini). Set AI_PROVIDER to force.
 */

import { hasAiProvider, promptText } from "../src/ai-providers.ts"
import { humaniseAutoSteerMessage } from "../src/utils/auto-steer-helpers.ts"

// Representative raw steer messages, mirroring the hook producers that call scheduleAutoSteer.
const SAMPLES: Array<{ label: string; text: string }> = [
  {
    label: "task-governance deny",
    text: "Run TaskList to sync task state before Bash. Then create at least 2 pending tasks and mark one in_progress before retrying.",
  },
  {
    label: "test-pairing reminder",
    text: "You changed src/auto-steer-store.ts but did not touch src/auto-steer-store.test.ts. Add or update tests for the dedup_key change.",
  },
  {
    label: "short default",
    text: "Continue",
  },
]

console.log("=== humaniseAutoSteerMessage latency + quality probe ===")
console.log("hasAiProvider():", hasAiProvider())
console.log("AI_PROVIDER env:", process.env.AI_PROVIDER ?? "(auto)")
console.log("")

// Baseline: forced no-backend path (what every fail-open call costs).
{
  const prev = process.env.AI_TEST_NO_BACKEND
  process.env.AI_TEST_NO_BACKEND = "1"
  const t0 = performance.now()
  const out = await humaniseAutoSteerMessage(SAMPLES[0]!.text)
  const ms = performance.now() - t0
  console.log(`--- baseline (no backend, fail-open) ---`)
  console.log(`elapsed ms: ${ms.toFixed(1)}  (expected ~0, returns raw)`)
  console.log(`returned === input:`, out === SAMPLES[0]!.text)
  console.log("")
  if (prev === undefined) delete process.env.AI_TEST_NO_BACKEND
  else process.env.AI_TEST_NO_BACKEND = prev
}

if (!hasAiProvider()) {
  console.log("No AI provider available — cannot measure live rewrite latency. Stop.")
  process.exit(0)
}

for (const sample of SAMPLES) {
  const t0 = performance.now()
  const out = await humaniseAutoSteerMessage(sample.text)
  const ms = performance.now() - t0
  console.log(`--- ${sample.label} ---`)
  console.log(`elapsed ms: ${ms.toFixed(1)}`)
  console.log(`changed: ${out !== sample.text}`)
  console.log(`raw (${sample.text.length} chars): ${sample.text}`)
  console.log(`out (${out.length} chars): ${out}`)
  console.log("")
}

// Surface the real error when forcing the OpenRouter provider (humanise swallows it).
{
  console.log("--- forced OpenRouter error probe ---")
  const t0 = performance.now()
  try {
    const out = await promptText(`Rewrite in one short sentence: ${SAMPLES[0]!.text}`, {
      provider: "openrouter",
      timeout: 8000,
    })
    console.log(`elapsed ms: ${(performance.now() - t0).toFixed(1)}`)
    console.log(`SUCCESS (${out.length} chars): ${out.slice(0, 120)}`)
  } catch (e) {
    console.log(`elapsed ms: ${(performance.now() - t0).toFixed(1)}`)
    console.log(`THREW: ${(e as Error).message}`)
  }
  console.log("")
}

// Decisive probe: does the timeout actually abort the provider call?
// 2s timeout. If honored → returns at ~2s. If ignored by claude-code → runs full duration.
{
  console.log("--- timeout enforcement probe (2s timeout direct on promptText) ---")
  const t0 = performance.now()
  try {
    const out = await promptText(`Rewrite in one short sentence: ${SAMPLES[0]!.text}`, {
      timeout: 2000,
    })
    const ms = performance.now() - t0
    console.log(`elapsed ms: ${ms.toFixed(1)}  <-- expected ~2000 if timeout honored`)
    console.log(`returned (${out.length} chars): ${out.slice(0, 80)}...`)
    console.log(ms > 4000 ? "VERDICT: timeout IGNORED by provider" : "VERDICT: timeout honored")
  } catch (e) {
    const ms = performance.now() - t0
    console.log(`elapsed ms: ${ms.toFixed(1)} — threw: ${(e as Error).message.slice(0, 80)}`)
    console.log(
      ms < 4000 ? "VERDICT: timeout honored (aborted via throw)" : "VERDICT: timeout late"
    )
  }
}
