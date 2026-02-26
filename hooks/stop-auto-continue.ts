#!/usr/bin/env bun
// Stop hook: Always block stop with an AI-generated next-step suggestion.
// Falls back to a generic nudge if no AI backend is available or it fails.
// Only skips for trivial sessions (< MIN_TOOL_CALLS).

import { promptAgent, detectAgentCli } from "../src/agent.ts";
import { blockStopRaw, type StopHookInput } from "./hook-utils.ts";
import {
  extractPlainTurns,
  countToolCalls,
  formatTurnsAsContext,
} from "../src/transcript-utils.ts";

const MIN_TOOL_CALLS = 5;  // Don't engage for trivial sessions
const CONTEXT_TURNS = 15;  // Recent turns to send as context

const FALLBACK_SUGGESTION =
  "Review the session transcript and identify the most important incomplete task or loose end before stopping.";

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

  let suggestion = FALLBACK_SUGGESTION;

  if (detectAgentCli()) {
    const context = formatTurnsAsContext(turns);
    const prompt =
      `You are analyzing a conversation between a user and an AI assistant. ` +
      `Based on the conversation below, suggest a single concrete next step the ` +
      `assistant should take. Be specific and actionable. Start with an imperative ` +
      `verb (Run, Fix, Add, Check, Verify, Commit, etc.). ` +
      `Write ONLY the suggestion itself — no prefix, no explanation.\n\n` +
      `<conversation>\n${context}\n</conversation>`;

    try {
      const aiSuggestion = await promptAgent(prompt);
      if (aiSuggestion) suggestion = aiSuggestion;
    } catch {
      // AI backend failed — fall through to FALLBACK_SUGGESTION
    }
  }

  blockStopRaw(`Suggested next step: ${suggestion}`);
}

main();
