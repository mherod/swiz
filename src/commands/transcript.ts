import { join, resolve } from "node:path";
import { readdir, stat } from "node:fs/promises";
import type { Command } from "../types.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ContentBlock {
  type: string;
  text?: string;
}

interface TranscriptEntry {
  type: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
  };
}

interface Session {
  id: string;
  path: string;
  mtime: number;
}

// ─── Project key ─────────────────────────────────────────────────────────────

function projectKeyFromCwd(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

// ─── Session discovery ───────────────────────────────────────────────────────

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
    const id = entry.slice(0, -6); // strip .jsonl
    const filePath = join(projectDir, entry);
    try {
      const s = await stat(filePath);
      sessions.push({ id, path: filePath, mtime: s.mtimeMs });
    } catch {
      continue;
    }
  }

  return sessions.sort((a, b) => b.mtime - a.mtime); // newest first
}

// ─── Text extraction ─────────────────────────────────────────────────────────

function extractText(content: string | ContentBlock[] | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("\n")
    .trim();
}

// ─── ANSI helpers ────────────────────────────────────────────────────────────

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

// ─── Rendering ───────────────────────────────────────────────────────────────

function wordWrap(text: string, width: number, indent: string): string {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of paragraph.split(" ")) {
      if (current.length === 0) {
        current = word;
      } else if (current.length + 1 + word.length <= width) {
        current += " " + word;
      } else {
        lines.push(indent + current);
        current = word;
      }
    }
    if (current) lines.push(indent + current);
  }
  return lines.join("\n");
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function renderTurn(
  role: "user" | "assistant",
  text: string,
  timestamp?: string
): void {
  if (!text.trim()) return;

  const isUser = role === "user";
  const label = isUser ? "USER" : "ASSISTANT";
  const color = isUser ? YELLOW : CYAN;
  const ts = timestamp ? ` ${DIM}${formatTimestamp(timestamp)}${RESET}` : "";

  console.log(`\n${color}${BOLD}${label}${RESET}${ts}`);

  const cols = process.stdout.columns ?? 80;
  const wrapWidth = Math.min(cols - 4, 100);
  const wrapped = wordWrap(text.trim(), wrapWidth, "  ");
  console.log(wrapped);
}

// ─── Main rendering ──────────────────────────────────────────────────────────

async function renderTranscript(sessionPath: string, sessionId: string): Promise<void> {
  const file = Bun.file(sessionPath);
  if (!(await file.exists())) {
    console.error(`Transcript not found: ${sessionPath}`);
    process.exit(1);
  }

  const text = await file.text();
  const lines = text.split("\n").filter(Boolean);

  console.log(
    `\n${DIM}Session: ${sessionId}${RESET}\n${DIM}${"─".repeat(60)}${RESET}`
  );

  let turnCount = 0;
  for (const line of lines) {
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type !== "user" && entry.type !== "assistant") continue;
    const msg = entry.message;
    if (!msg) continue;

    const text = extractText(msg.content);
    if (!text.trim()) continue;

    // Skip hook feedback injected as user messages (they look like stop hook output)
    if (
      entry.type === "user" &&
      typeof msg.content === "string" &&
      (msg.content.startsWith("Stop hook feedback:") ||
        msg.content.startsWith("<command-message>"))
    ) {
      continue;
    }

    renderTurn(entry.type as "user" | "assistant", text, entry.timestamp);
    turnCount++;
  }

  if (turnCount === 0) {
    console.log(`\n  ${DIM}(no conversation turns found)${RESET}\n`);
  } else {
    console.log(`\n${DIM}${"─".repeat(60)}${RESET}\n`);
  }
}

// ─── Command ─────────────────────────────────────────────────────────────────

export const transcriptCommand: Command = {
  name: "transcript",
  description: "Display Agent-User chat history for the current project",
  usage: "swiz transcript [--session <id>] [--dir <path>] [--list]",
  async run(args) {
    const HOME = process.env.HOME ?? "~";
    const PROJECTS_DIR = join(HOME, ".claude", "projects");

    // Parse flags
    let sessionQuery: string | null = null;
    let targetDir: string = process.cwd();
    let listOnly = false;

    for (let i = 0; i < args.length; i++) {
      if ((args[i] === "--session" || args[i] === "-s") && args[i + 1]) {
        sessionQuery = args[++i]!;
      } else if ((args[i] === "--dir" || args[i] === "-d") && args[i + 1]) {
        targetDir = resolve(args[++i]!);
      } else if (args[i] === "--list" || args[i] === "-l") {
        listOnly = true;
      }
    }

    const projectKey = projectKeyFromCwd(targetDir);
    const projectDir = join(PROJECTS_DIR, projectKey);

    const sessions = await findSessions(projectDir);

    if (sessions.length === 0) {
      console.error(`No transcripts found for: ${targetDir}`);
      console.error(`(looked in: ${projectDir})`);
      process.exit(1);
    }

    if (listOnly) {
      console.log(`\n  Transcripts for ${targetDir}\n`);
      for (const s of sessions) {
        const d = new Date(s.mtime);
        const label = d.toLocaleString([], {
          dateStyle: "short",
          timeStyle: "short",
        });
        console.log(`  ${s.id}  ${DIM}${label}${RESET}`);
      }
      console.log();
      return;
    }

    // Find the target session
    let session: Session;
    if (sessionQuery) {
      const match = sessions.find((s) => s.id.startsWith(sessionQuery!));
      if (!match) {
        console.error(`No session matching: ${sessionQuery}`);
        console.error(`Available sessions:`);
        for (const s of sessions) console.error(`  ${s.id}`);
        process.exit(1);
      }
      session = match;
    } else {
      session = sessions[0]!; // newest session
    }

    await renderTranscript(session.path, session.id);
  },
};
