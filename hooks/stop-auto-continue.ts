#!/usr/bin/env bun
// Stop hook: Suggest a next step by prompting an AI agent with the transcript context.
// Blocks stop with the suggestion; allows stop on the next attempt (stop_hook_active).
// Silently allows stop if no AI backend is available or the transcript is too short.

import { promptAgent, detectAgentCli } from "../src/agent.ts";
import { blockStopRaw, type StopHookInput } from "./hook-utils.ts";
import {
  extractPlainTurns,
  countToolCalls,
  formatTurnsAsContext,
} from "../src/transcript-utils.ts";

const MIN_TOOL_CALLS = 5;  // Don't engage for trivial sessions
const CONTEXT_TURNS = 15;  // Recent turns to send as context

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as StopHookInput;

  // Allow stop on retry — prevents blocking forever after the suggestion is shown
  if (input.stop_hook_active) return;

  // Need a transcript and an AI backend to work
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

  let suggestion: string;
  try {
    suggestion = await promptAgent(prompt);
  } catch {
    return; // No backend or backend failed — allow stop silently
  }

  if (!suggestion) return;

  blockStopRaw(`Suggested next step: ${suggestion}`);
}

main();
