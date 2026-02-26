import { join, resolve } from "node:path";
import type { Command } from "../types.ts";
import { promptAgent, detectAgentCli } from "../agent.ts";
import {
  projectKeyFromCwd,
  findSessions,
  extractPlainTurns,
  formatTurnsAsContext,
  type Session,
} from "../transcript-utils.ts";

// ─── Next-step suggestion ─────────────────────────────────────────────────────

async function generateNextStep(jsonlText: string): Promise<string> {
  const turns = extractPlainTurns(jsonlText).slice(-20);
  const context = formatTurnsAsContext(turns);

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

    let raw: string;
    try {
      raw = await Bun.file(session.path).text();
    } catch {
      console.error(`Could not read transcript: ${session.path}`);
      process.exit(1);
    }

    let suggestion: string;
    try {
      suggestion = await generateNextStep(raw);
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
