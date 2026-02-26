#!/usr/bin/env bun
// Stop hook: Block stop with an AI-generated next-step suggestion.
// Retries up to MAX_RETRIES times if the backend fails.
// Only skips for trivial sessions (< MIN_TOOL_CALLS) or when no backend is available.

import { promptAgent, detectAgentCli } from "../src/agent.ts";
import { blockStopRaw, type StopHookInput } from "./hook-utils.ts";
import {
  extractPlainTurns,
  countToolCalls,
  formatTurnsAsContext,
} from "../src/transcript-utils.ts";

const MIN_TOOL_CALLS = 5;  // Don't engage for trivial sessions
const CONTEXT_TURNS = 15;  // Recent turns to send as context
const MAX_RETRIES = 3;

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as StopHookInput;

  if (!input.transcript_path) return;
  if (!detectAgentCli()) return;

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

  const context = formatTurnsAsContext(turns);
  const prompt =
    `You are analyzing a conversation between a user and an AI assistant. ` +
    `Based on the conversation below, suggest a single concrete next step the ` +
    `assistant should take. Be specific and actionable. Start with an imperative ` +
    `verb (Run, Fix, Add, Check, Verify, Commit, etc.). ` +
    `Write ONLY the suggestion itself — no prefix, no explanation.\n\n` +
    `<conversation>\n${context}\n</conversation>`;

  let suggestion = "";
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await promptAgent(prompt);
      if (result) {
        suggestion = result;
        break;
      }
    } catch {
      // retry
    }
  }

  if (!suggestion) return; // all retries exhausted, allow stop silently

  blockStopRaw(`Suggested next step: ${suggestion}`);
}

main();
