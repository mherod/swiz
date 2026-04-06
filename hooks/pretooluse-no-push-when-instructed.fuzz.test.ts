/**
 * Property-based fuzz tests for pretooluse-no-push-when-instructed.ts
 *
 * These tests encode invariants that must hold across ALL inputs rather
 * than specific examples. Each test generates many variants automatically
 * and verifies the property holds for every one.
 *
 * Properties under test:
 *   P1 BLOCK_SURVIVES_NOISE  — blocking phrase embedded in arbitrary surrounding
 *                              text always triggers a block (user-role only)
 *   P2 APPROVAL_LIFTS_BLOCK  — any recognised approval phrase appearing after a
 *                              block always lifts the restriction
 *   P3 NEUTRAL_NO_CHANGE     — text not matching any pattern never changes state
 *   P4 FINAL_STATE_WINS      — only the last block/approve in a sequence matters
 *   P5 ROLE_INVARIANT        — blocking never fires from assistant-role text
 *   P6 APPROVAL_USER_ONLY   — approval fires only from user-role, never assistant
 *   P7 ASSISTANT_NEVER_SELF_APPROVES — approval phrases in assistant text are ignored
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"

// Fuzz tests spawn many subprocess variants; need generous timeout under full-suite load
setDefaultTimeout(60_000)

import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeTranscript, type SimpleHookResult } from "../src/utils/test-utils.ts"

// ─── Shared transcript builder & runner ──────────────────────────────────────

function entry(role: "user" | "assistant", text: string): string {
  return JSON.stringify({ type: role, message: { content: [{ type: "text", text }] } })
}

let tmpDir: string
let fakeHome: string // HOME with pushGate:true settings file — enables the hook in tests

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "no-push-fuzz-"))
  fakeHome = join(tmpDir, "home")
  await mkdir(join(fakeHome, ".swiz"), { recursive: true })
  await Bun.write(
    join(fakeHome, ".swiz", "settings.json"),
    JSON.stringify({ pushGate: true }, null, 2)
  )
})

afterAll(async () => {
  await rm(tmpDir, { recursive: true })
})

async function runHook(transcriptContent: string): Promise<SimpleHookResult> {
  const tPath = join(tmpDir, `f-${Math.random().toString(36).slice(2)}.jsonl`)
  await Bun.write(tPath, transcriptContent)

  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: "git push origin main" },
    transcript_path: tPath,
    session_id: "fuzz",
    cwd: "/tmp",
  })

  const proc = Bun.spawn(["bun", "hooks/pretooluse-no-push-when-instructed.ts"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: fakeHome, SWIZ_DAEMON_PORT: "19999" },
  })
  await proc.stdin.write(payload)
  await proc.stdin.end()
  const out = await new Response(proc.stdout).text()
  await proc.exited

  if (!out.trim()) return { blocked: false, reason: "" }
  const parsed = JSON.parse(out.trim())
  const hso = parsed?.hookSpecificOutput
  return {
    blocked: (hso?.permissionDecision ?? parsed?.decision) === "deny",
    reason: hso?.permissionDecisionReason ?? parsed?.reason ?? "",
  }
}

// ─── Corpus definitions ───────────────────────────────────────────────────────

/** All blocking phrase cores recognised by NO_PUSH_RE */
const BLOCKING_CORES = [
  "do not push",
  "Do not push",
  "DO NOT push",
  "do NOT push",
  "Do Not Push",
  "DO NOT PUSH",
  "don't push",
  "Don't push",
  "DON'T push",
  "DON'T PUSH",
  "don't push", // typographic apostrophe
]

/** Surrounding noise fragments that must not suppress blocking */
const NOISE_PREFIX = [
  "",
  "Please note: ",
  "Important — ",
  "Reminder: ",
  "⚠️ Warning: ",
  "Note that you should ",
  "The rule is: ",
  "For safety, ",
]

const NOISE_SUFFIX = [
  "",
  " to the remote",
  " without approval",
  " to origin/main",
  " until CI is green",
  " — wait for review",
  ". Commit only.",
  "! This is mandatory.",
]

/** Lines of unrelated text that must never change hook state */
const NEUTRAL_LINES = [
  "Please run the test suite",
  "Fix the TypeScript error on line 42",
  "The deployment is scheduled for Friday",
  "Update the README with the new API",
  "I'll push it when the time is right", // future intent, not approval
  "you should push when CI is green", // conditional, not approval
  "a force push could lose history", // discussion, not approval
  "push changes to staging when ready", // indirect, not approval
  "the git push workflow is documented here", // reference, not approval
  "never push to main directly", // "never" not in pattern
  "must not push this branch", // "must not" not in pattern
  "pushover tactics won't work here", // "pushover" not in pattern
  "I reviewed the push request", // noun usage
  "/push-notifications.ts was updated", // path reference
  "run /push-to-deploy.sh to release", // path in sentence
]

/** Recognised approval phrase cores */
const APPROVAL_CORES = [
  "go ahead and push",
  "Go Ahead And Push",
  "GO AHEAD AND PUSH",
  "push now",
  "Push Now",
  "PUSH NOW",
  "please push",
  "Please push",
  "PLEASE PUSH",
  "/push",
  "/push ",
  "/push --force-with-lease",
]

/** Approval phrases that must NOT be recognised (not in patterns) */
const NON_APPROVAL_PHRASES = [
  // Stop-hook action plans — system-generated, NOT explicit human authorisation
  "Push 1 commit(s) to 'origin/main' with /push",
  "Push 2 commits to origin/main",
  "Push 3 commits to origin",
  "Push 10 commits",
  "Push 0 commits remaining in queue",
  // Skill content — loads automatically when agent invokes /push, NOT user authorisation
  "Get committed changes pushed to remote",
  "get committed changes pushed to remote",
  "push",
  "PUSH",
  "push it",
  "push to staging",
  "push changes",
  "push when ready",
  "I'll push later",
  "/push-button",
  "/push-notifications.ts",
  "/push-to-deploy.sh",
  "invoke /push", // /push not at start of line
  "run /push script", // same
  "Push commits exist", // no digit before "commit"
  "Push many commits", // no digit
]

// ─── P1: BLOCK_SURVIVES_NOISE ────────────────────────────────────────────────
// For every combination of (core × prefix × suffix), the hook must block.

describe("P1 BLOCK_SURVIVES_NOISE — blocking phrase always blocks regardless of context", () => {
  const cases: Array<{ label: string; text: string }> = []

  for (const core of BLOCKING_CORES) {
    for (const pre of NOISE_PREFIX) {
      for (const suf of NOISE_SUFFIX) {
        const text = `${pre}${core}${suf}`
        cases.push({ label: JSON.stringify(text), text })
      }
    }
  }

  for (const { label, text } of cases) {
    test(`blocks: ${label}`, async () => {
      const t = makeTranscript(entry("user", text))
      const result = await runHook(t)
      expect(result.blocked).toBe(true)
    })
  }
})

// ─── P2: APPROVAL_LIFTS_BLOCK ─────────────────────────────────────────────────
// For every recognised approval phrase, placing it after a block lifts restriction.

describe("P2 APPROVAL_LIFTS_BLOCK — recognised approval after a block always allows push", () => {
  const BLOCK_ENTRY = entry("user", "DO NOT push to remote without approval")

  for (const approvalText of APPROVAL_CORES) {
    test(`lifts block: ${JSON.stringify(approvalText)}`, async () => {
      const t = makeTranscript(BLOCK_ENTRY, entry("user", approvalText))
      const result = await runHook(t)
      expect(result.blocked).toBe(false)
    })
  }
})

// ─── P3: NEUTRAL_NO_CHANGE ───────────────────────────────────────────────────
// Neutral lines must not block when there is no blocking instruction,
// and must not lift a block when one exists.

describe("P3 NEUTRAL_NO_CHANGE — neutral text never changes hook state", () => {
  describe("neutral text alone does NOT block", () => {
    for (const text of NEUTRAL_LINES) {
      test(`no block from: ${JSON.stringify(text)}`, async () => {
        const t = makeTranscript(entry("user", text))
        expect((await runHook(t)).blocked).toBe(false)
      })
    }
  })

  describe("neutral text after a block does NOT lift it", () => {
    const BLOCK_ENTRY = entry("user", "DO NOT push to remote without approval")

    for (const text of NEUTRAL_LINES) {
      test(`still blocked after neutral: ${JSON.stringify(text)}`, async () => {
        const t = makeTranscript(BLOCK_ENTRY, entry("user", text))
        expect((await runHook(t)).blocked).toBe(true)
      })
    }
  })
})

// ─── P4: FINAL_STATE_WINS ────────────────────────────────────────────────────
// Property: given any sequence of alternating block/approve entries, the
// result must equal the state set by the LAST block or approve entry.

describe("P4 FINAL_STATE_WINS — result always reflects the last block or approve entry", () => {
  const BLOCK = "DO NOT push to remote"
  const APPROVE = "go ahead and push"

  /** Build a sequence of N block/approve entries; return [transcript, expectedBlocked] */
  function buildSequence(pattern: ("B" | "A")[]): [string, boolean] {
    const entries = pattern.map((p) => (p === "B" ? entry("user", BLOCK) : entry("user", APPROVE)))
    const lastIsBlock = pattern[pattern.length - 1] === "B"
    return [entries.join("\n"), lastIsBlock]
  }

  const sequences: Array<{ label: string; pattern: ("B" | "A")[] }> = [
    { label: "B", pattern: ["B"] },
    { label: "A B", pattern: ["A", "B"] },
    { label: "B A", pattern: ["B", "A"] },
    { label: "B A B", pattern: ["B", "A", "B"] },
    { label: "B A B A", pattern: ["B", "A", "B", "A"] },
    { label: "A B A B", pattern: ["A", "B", "A", "B"] },
    { label: "B B B", pattern: ["B", "B", "B"] },
    { label: "B A A A", pattern: ["B", "A", "A", "A"] },
    { label: "A A A B", pattern: ["A", "A", "A", "B"] },
    { label: "B A B A B", pattern: ["B", "A", "B", "A", "B"] },
    { label: "A B B B A", pattern: ["A", "B", "B", "B", "A"] },
    { label: "B×10 then A", pattern: [...(Array(10).fill("B") as "B"[]), "A"] },
    { label: "A×10 then B", pattern: [...(Array(10).fill("A") as "A"[]), "B"] },
  ]

  for (const { label, pattern } of sequences) {
    test(`sequence [${label}] → last=${pattern[pattern.length - 1]}`, async () => {
      const [t, expectedBlocked] = buildSequence(pattern)
      const result = await runHook(t)
      expect(result.blocked).toBe(expectedBlocked)
    })
  }
})

// ─── P5: ROLE_INVARIANT ──────────────────────────────────────────────────────
// Blocking phrases in assistant-role entries must NEVER trigger a block.

describe("P5 ROLE_INVARIANT — blocking phrases in assistant text never block", () => {
  for (const core of BLOCKING_CORES) {
    test(`assistant role does not block: ${JSON.stringify(core)}`, async () => {
      const t = makeTranscript(entry("assistant", `${core} to remote without approval`))
      expect((await runHook(t)).blocked).toBe(false)
    })
  }
})

// ─── P6: APPROVAL_USER_ONLY ──────────────────────────────────────────────────
// Approval phrases lift the block only when they appear in user-role entries.
// Both blocking and approval are restricted to user-role so the agent cannot
// self-approve a push through its own reasoning text.

describe("P6 APPROVAL_USER_ONLY — approval phrases lift block only from user role", () => {
  const BLOCK_ENTRY = entry("user", "DO NOT push to remote without approval")

  const REPRESENTATIVE_APPROVALS = ["go ahead and push", "push now", "please push"]

  for (const approvalText of REPRESENTATIVE_APPROVALS) {
    test(`user approval lifts: ${JSON.stringify(approvalText)}`, async () => {
      const t = makeTranscript(BLOCK_ENTRY, entry("user", approvalText))
      expect((await runHook(t)).blocked).toBe(false)
    })
  }
})

// ─── P7: ASSISTANT_NEVER_SELF_APPROVES ───────────────────────────────────────
// Approval phrases in assistant-role entries must NEVER lift a block.
// Prevents the agent's own reasoning from self-approving a push.

describe("P7 ASSISTANT_NEVER_SELF_APPROVES — approval phrases in assistant text never lift block", () => {
  const BLOCK_ENTRY = entry("user", "DO NOT push to remote without approval")

  const REPRESENTATIVE_APPROVALS = ["go ahead and push", "push now", "please push", "/push"]

  for (const approvalText of REPRESENTATIVE_APPROVALS) {
    test(`assistant approval ignored: ${JSON.stringify(approvalText)}`, async () => {
      const t = makeTranscript(BLOCK_ENTRY, entry("assistant", approvalText))
      expect((await runHook(t)).blocked).toBe(true)
    })
  }
})

// ─── NON-APPROVAL corpus ─────────────────────────────────────────────────────
// These phrases must NOT grant approval — they resemble approval but fall
// outside every recognised pattern.

describe("Non-approval phrases do not lift a block", () => {
  const BLOCK_ENTRY = entry("user", "DO NOT push to remote without approval")

  for (const text of NON_APPROVAL_PHRASES) {
    test(`no approval from: ${JSON.stringify(text)}`, async () => {
      const t = makeTranscript(BLOCK_ENTRY, entry("user", text))
      expect((await runHook(t)).blocked).toBe(true)
    })
  }
})
