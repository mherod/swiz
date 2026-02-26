import { join, resolve } from "node:path";
import { readdir, stat } from "node:fs/promises";
import type { Command } from "../types.ts";
import { promptAgent, detectAgentCli } from "../agent.ts";

// ─── Session discovery (mirrors transcript.ts) ────────────────────────────────

interface Session {
  id: string;
  path: string;
  mtime: number;
}

function projectKeyFromCwd(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

async function findSessions(projectDir: string): Promise<Session[]> {
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

// ─── Turn extraction ──────────────────────────────────────────────────────────

interface TextBlock { type: "text"; text?: string }
interface ToolUseBlock { type: "tool_use"; name?: string }
type ContentBlock = TextBlock | ToolUseBlock | { type: string };

interface Turn {
  role: "user" | "assistant";
  text: string;
}

function extractText(content: string | ContentBlock[] | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return (content as ContentBlock[])
    .filter((b): b is TextBlock => b.type === "text" && !!(b as TextBlock).text)
    .map((b) => b.text!)
    .join("\n")
    .trim();
}

async function loadTurns(sessionPath: string, limit = 20): Promise<Turn[]> {
  const file = Bun.file(sessionPath);
  if (!(await file.exists())) return [];

  const text = await file.text();
  const turns: Turn[] = [];

  for (const line of text.split("\n").filter(Boolean)) {
    try {
      const entry = JSON.parse(line);
      if (entry?.type !== "user" && entry?.type !== "assistant") continue;

      const msg = entry.message;
      if (!msg) continue;

      // Skip hook feedback injected as user messages
      if (
        entry.type === "user" &&
        typeof msg.content === "string" &&
        (msg.content.startsWith("Stop hook feedback:") ||
          msg.content.startsWith("<command-message>"))
      ) continue;

      if (entry.type === "assistant") {
        const blocks: ContentBlock[] = typeof msg.content === "string"
          ? [{ type: "text", text: msg.content }]
          : (msg.content ?? []);
        const textParts = (blocks as ContentBlock[])
          .filter((b): b is TextBlock => b.type === "text" && !!(b as TextBlock).text?.trim())
          .map((b) => b.text!.trim());
        if (textParts.length === 0) continue;
        turns.push({ role: "assistant", text: textParts.join("\n") });
      } else {
        const text = extractText(msg.content).trim();
        if (!text) continue;
        turns.push({ role: "user", text });
      }
    } catch {}
  }

  return turns.slice(-limit);
}

// ─── Next-step suggestion ─────────────────────────────────────────────────────

async function generateNextStep(turns: Turn[]): Promise<string> {
  const context = turns
    .map(({ role, text }) => `${role === "user" ? "User" : "Assistant"}: ${text}`)
    .join("\n\n");

  const prompt =
    `You are analyzing a conversation between a user and an AI assistant. ` +
    `Based on the conversation below, suggest a single concrete next step the ` +
    `assistant should take. Be specific and actionable. ` +
    `Reply with ONLY one sentence starting with an imperative verb ` +
    `(Run, Fix, Add, Check, Verify, Commit, etc.) — ` +
    `no explanation, no markdown, no prefix, no period at the end.\n\n` +
    `<conversation>\n${context}\n</conversation>`;

  return promptAgent(prompt);
}

// ─── Command ──────────────────────────────────────────────────────────────────

export const continueCommand: Command = {
  name: "continue",
  description: "Resume the most recent session with an AI-generated next step",
  usage: "swiz continue [--dir <path>] [--session <id>] [--print]",
  async run(args) {
    const HOME = process.env.HOME ?? "~";
    const PROJECTS_DIR = join(HOME, ".claude", "projects");

    let targetDir = process.cwd();
    let sessionQuery: string | null = null;
    let printOnly = false;

    for (let i = 0; i < args.length; i++) {
      if ((args[i] === "--dir" || args[i] === "-d") && args[i + 1]) {
        targetDir = resolve(args[++i]!);
      } else if ((args[i] === "--session" || args[i] === "-s") && args[i + 1]) {
        sessionQuery = args[++i]!;
      } else if (args[i] === "--print") {
        printOnly = true;
      }
    }

    if (!detectAgentCli()) {
      console.error("No AI backend found. Install one of: Cursor Agent (agent), Claude Code (claude), or Gemini CLI (gemini).");
      process.exit(1);
    }

    const projectKey = projectKeyFromCwd(targetDir);
    const projectDir = join(PROJECTS_DIR, projectKey);
    const sessions = await findSessions(projectDir);

    if (sessions.length === 0) {
      console.error(`No transcripts found for: ${targetDir}`);
      process.exit(1);
    }

    let session: Session;
    if (sessionQuery) {
      const match = sessions.find((s) => s.id.startsWith(sessionQuery!));
      if (!match) {
        console.error(`No session matching: ${sessionQuery}`);
        process.exit(1);
      }
      session = match;
    } else {
      session = sessions[0]!;
    }

    const turns = await loadTurns(session.path);
    if (turns.length === 0) {
      console.error("No conversation turns found in session.");
      process.exit(1);
    }

    let suggestion: string;
    try {
      suggestion = await generateNextStep(turns);
    } catch (err) {
      console.error(`Failed to generate suggestion: ${String(err)}`);
      process.exit(1);
    }

    if (!suggestion) {
      console.error("Empty suggestion returned from AI backend.");
      process.exit(1);
    }

    if (printOnly) {
      console.log(suggestion);
      return;
    }

    // Resume the session with the suggestion as the first user message.
    // --session flag maps to --resume <id>; default uses --continue (most recent).
    const resumeArgs: string[] = sessionQuery
      ? ["claude", "--resume", session.id, suggestion]
      : ["claude", "--continue", suggestion];

    const proc = Bun.spawn(resumeArgs, {
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });
    await proc.exited;
    process.exit(proc.exitCode ?? 0);
  },
};
