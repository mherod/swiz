#!/usr/bin/env bun
// Stop hook: Suggest a next step by prompting an AI agent with the transcript context.
// Blocks stop ONCE with the suggestion; allows stop on the next attempt (stop_hook_active).
// Silently allows stop if no AI backend is available or the transcript is too short.

import { promptAgent, detectAgentCli } from "../src/agent.ts";
import { blockStopRaw, type StopHookInput } from "./hook-utils.ts";

const MIN_TOOL_CALLS = 5;   // Don't engage for trivial sessions
const CONTEXT_TURNS = 15;   // Recent turns to send as context

// ─── Plain-text context builder ───────────────────────────────────────────────
// Produces "User: ...\nAssistant: ...\n" suitable for an LLM context window.

interface TextTurn {
  role: "user" | "assistant";
  text: string;
}

async function extractTextTurns(transcriptPath: string): Promise<TextTurn[]> {
  try {
    const raw = await Bun.file(transcriptPath).text();
    const turns: TextTurn[] = [];

    for (const line of raw.split("\n").filter(Boolean)) {
      try {
        const entry = JSON.parse(line);
        if (entry?.type !== "user" && entry?.type !== "assistant") continue;

        const content = entry?.message?.content;
        if (!content) continue;

        // Skip injected hook feedback
        if (
          entry.type === "user" &&
          typeof content === "string" &&
          (content.startsWith("Stop hook feedback:") ||
            content.startsWith("<command-message>"))
        ) continue;

        let text: string;
        if (typeof content === "string") {
          text = content;
        } else if (Array.isArray(content)) {
          text = content
            .filter((b: { type?: string; text?: string }) => b?.type === "text" && b?.text)
            .map((b: { text?: string }) => b.text!)
            .join("\n");
        } else {
          continue;
        }

        text = text.trim();
        if (text) turns.push({ role: entry.type, text });
      } catch {}
    }

    return turns.slice(-CONTEXT_TURNS);
  } catch {
    return [];
  }
}

async function countToolCalls(transcriptPath: string): Promise<number> {
  try {
    const raw = await Bun.file(transcriptPath).text();
    let count = 0;
    for (const line of raw.split("\n").filter(Boolean)) {
      try {
        const entry = JSON.parse(line);
        if (entry?.type !== "assistant") continue;
        const content = entry?.message?.content;
        if (!Array.isArray(content)) continue;
        count += content.filter((b: { type?: string }) => b?.type === "tool_use").length;
      } catch {}
    }
    return count;
  } catch {
    return 0;
  }
}

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as StopHookInput;

  // Prevent infinite loop — agent has already seen the suggestion and is stopping again
  if (input.stop_hook_active) return;

  // Need a transcript and an AI backend to work
  if (!input.transcript_path) return;
  if (!detectAgentCli()) return;

  // Only engage for substantive sessions
  const toolCallCount = await countToolCalls(input.transcript_path);
  if (toolCallCount < MIN_TOOL_CALLS) return;

  const turns = await extractTextTurns(input.transcript_path);
  if (turns.length === 0) return;

  const context = turns
    .map(({ role, text }) => `${role === "user" ? "User" : "Assistant"}: ${text}`)
    .join("\n\n");

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
