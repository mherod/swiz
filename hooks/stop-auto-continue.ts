#!/usr/bin/env bun
// Stop hook: Block stop with an AI-generated next-step suggestion.
// Retries ferociously (MAX_RETRIES attempts) before falling back to a generic nudge.
// Only skips for trivial sessions (< MIN_TOOL_CALLS) or when no backend is available.

import { promptAgent, detectAgentCli } from "../src/agent.ts";
import { blockStopRaw, type StopHookInput } from "./hook-utils.ts";
import {
  extractPlainTurns,
  countToolCalls,
  formatTurnsAsContext,
} from "../src/transcript-utils.ts";

const MIN_TOOL_CALLS = 5;       // Don't engage for trivial sessions
const CONTEXT_TURNS = 15;       // Recent turns to send as context
const MAX_RETRIES = 5;
const ATTEMPT_TIMEOUT_MS = Number(process.env.ATTEMPT_TIMEOUT_MS) || 20_000;

const FALLBACK_SUGGESTION =
  "Review the session transcript, identify the most critical incomplete task, and complete it autonomously without asking for confirmation.";

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as StopHookInput;

  if (!input.transcript_path) return;

  let raw: string;
  try {
    raw = await Bun.file(input.transcript_path).text();
  } catch {
    return;
  }

  // Only engage for substantive sessions
  if (countToolCalls(raw) < MIN_TOOL_CALLS) return;

  const turns = extractPlainTurns(raw).slice(-CONTEXT_TURNS);
  if (turns.length === 0) return;

  let suggestion = "";

  if (detectAgentCli()) {
    const context = formatTurnsAsContext(turns);
    const prompt =
      `You are analyzing a conversation between a user and an AI assistant. ` +
      `The assistant is about to stop. Identify the boldest, highest-impact action ` +
      `it should execute next — autonomously, without asking the user any questions ` +
      `or waiting for confirmation. ` +
      `PRIORITY ORDER: (1) If any errors, failures, bugs, warnings, or issues were identified ` +
      `or surfaced during the conversation but NOT yet resolved or acted upon, those take ` +
      `HIGHEST priority — investigate and fix them before anything else. ` +
      `(2) If any task or feature was started but left incomplete, finish it. ` +
      `(3) Otherwise, find the next valuable improvement (tests, edge cases, related issues, quality). ` +
      `Be ambitious. There is always more to do: more to test, more to improve, more to ship. ` +
      `NEVER conclude that work is complete or that nothing remains. ` +
      `Start with an imperative verb (Run, Fix, Add, Check, Verify, Commit, Improve, Investigate, etc.). ` +
      `CRITICAL: Reply with ONE sentence only — no preamble, no explanation, no questions. ` +
      `The step must be something the assistant can do right now on its own. ` +
      `Do NOT suggest asking the user, confirming scope, or presenting options.\n\n` +
      `<conversation>\n${context}\n</conversation>`;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), ATTEMPT_TIMEOUT_MS);
      try {
        const agentP = promptAgent(prompt, { promptOnly: true, signal: ac.signal });
        agentP.catch(() => {});
        const result = await Promise.race([
          agentP,
          new Promise<never>((_, reject) => {
            if (ac.signal.aborted) return reject(new Error("timeout"));
            ac.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
          }),
        ]);
        if (result) {
          suggestion = result;
          break;
        }
      } catch {
        // retry (includes timeout / abort)
      } finally {
        clearTimeout(timer);
      }
    }
  }

  blockStopRaw(`Continue autonomously — do not ask questions or wait for confirmation: ${suggestion || FALLBACK_SUGGESTION}`);
}

main();
