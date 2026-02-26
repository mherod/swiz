import { join } from "node:path";
import { readdir, stat } from "node:fs/promises";

// ─── Content block types ─────────────────────────────────────────────────────

export interface TextBlock {
  type: "text";
  text?: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | { type: string; [key: string]: unknown };

export interface TranscriptEntry {
  type: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
  };
}

// ─── Session discovery ───────────────────────────────────────────────────────

export interface Session {
  id: string;
  path: string;
  mtime: number;
}

export function projectKeyFromCwd(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

export async function findSessions(projectDir: string): Promise<Session[]> {
  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return [];
  }

  const sessions: Session[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const id = entry.slice(0, -6);
    const filePath = join(projectDir, entry);
    try {
      const s = await stat(filePath);
      sessions.push({ id, path: filePath, mtime: s.mtimeMs });
    } catch {
      continue;
    }
  }

  return sessions.sort((a, b) => b.mtime - a.mtime);
}

// ─── Text extraction ─────────────────────────────────────────────────────────

export function extractText(
  content: string | ContentBlock[] | undefined
): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter((b): b is TextBlock => b.type === "text" && !!(b as TextBlock).text)
    .map((b) => b.text!)
    .join("\n")
    .trim();
}

export function isHookFeedback(
  content: string | ContentBlock[] | undefined
): boolean {
  if (typeof content !== "string") return false;
  return (
    content.startsWith("Stop hook feedback:") ||
    content.startsWith("<command-message>")
  );
}

// ─── Plain turn extraction ───────────────────────────────────────────────────
// Produces simple {role, text} pairs from raw JSONL — shared by continue.ts
// and stop-auto-continue.ts where rendering details are not needed.

export interface PlainTurn {
  role: "user" | "assistant";
  text: string;
}

export function extractPlainTurns(jsonlText: string): PlainTurn[] {
  const turns: PlainTurn[] = [];

  for (const line of jsonlText.split("\n").filter(Boolean)) {
    try {
      const entry = JSON.parse(line);
      if (entry?.type !== "user" && entry?.type !== "assistant") continue;

      const content = entry?.message?.content;
      if (!content) continue;

      if (entry.type === "user" && isHookFeedback(content)) continue;

      let text: string;
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        text = content
          .filter(
            (b: { type?: string; text?: string }) =>
              b?.type === "text" && b?.text
          )
          .map((b: { text?: string }) => b.text!)
          .join("\n");
      } else {
        continue;
      }

      text = text.trim();
      if (text) turns.push({ role: entry.type, text });
    } catch {}
  }

  return turns;
}

// ─── Tool call counting ──────────────────────────────────────────────────────

export function countToolCalls(jsonlText: string): number {
  let count = 0;
  for (const line of jsonlText.split("\n").filter(Boolean)) {
    try {
      const entry = JSON.parse(line);
      if (entry?.type !== "assistant") continue;
      const content = entry?.message?.content;
      if (!Array.isArray(content)) continue;
      count += content.filter(
        (b: { type?: string }) => b?.type === "tool_use"
      ).length;
    } catch {}
  }
  return count;
}

// ─── Context formatting ──────────────────────────────────────────────────────
// Formats plain turns into a labeled conversation string for LLM prompts.

export function formatTurnsAsContext(turns: PlainTurn[]): string {
  return turns
    .map(
      ({ role, text }) =>
        `${role === "user" ? "User" : "Assistant"}: ${text}`
    )
    .join("\n\n");
}
