#!/usr/bin/env bun
// Stop hook: Extract confirmed patterns from the session transcript and
// append them to the project's auto-memory file (MEMORY.md).
// Never blocks stop — always returns {"ok": true}.
// Follows the /update-memory ethos: prescriptive DO/DON'T directives,
// no narrative, no temporal language, specific details.

import { type StopHookInput } from "./hook-utils.ts";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export {};

const HOME = process.env.HOME ?? "~";
const PROJECTS_DIR = join(HOME, ".claude", "projects");

// ─── Directive extraction ───────────────────────────────────────────────────
// Match explicit user preferences and rules. Conservative — better to miss
// a pattern than to write something wrong to memory.

const DIRECTIVE_RES: Array<{ re: RegExp; prefix: string }> = [
  // Explicit directives (high confidence)
  { re: /\balways\s+use\b/i, prefix: "DO" },
  { re: /\bnever\s+use\b/i, prefix: "DON'T" },
  { re: /\bdon'?t\s+use\b/i, prefix: "DON'T" },
  { re: /\bavoid\s+using\b/i, prefix: "DON'T" },
  { re: /\bstop\s+(?:using|doing)\b/i, prefix: "DON'T" },
  { re: /\bfrom\s+now\s+on\b/i, prefix: "DO" },
  { re: /\bgoing\s+forward\b/i, prefix: "DO" },
  { re: /\bremember\s+(?:that|to)\b/i, prefix: "DO" },
  { re: /\bprefer\s+\w+\s+over\b/i, prefix: "DO" },
  { re: /\buse\s+\w+\s+instead\s+of\b/i, prefix: "DO" },
  { re: /\bmake\s+sure\s+(?:to|that)\b/i, prefix: "DO" },
  { re: /\bthe\s+(?:rule|convention)\s+is\b/i, prefix: "" },
  // Conversational directives (medium confidence)
  { re: /\bwe\s+should\s+(?:always|never|use|write|keep)\b/i, prefix: "DO" },
  { re: /\bshouldn'?t\s+(?:use|assume|have|add|include)\b/i, prefix: "DON'T" },
  { re: /\blet'?s\s+(?:use|switch\s+to|convert|move\s+to)\b/i, prefix: "DO" },
  { re: /\bthis\s+project\s+uses\b/i, prefix: "DO" },
  { re: /\bwe\s+use\s+\w+\s+(?:for|in|across)\b/i, prefix: "DO" },
  { re: /\brather\s+than\b/i, prefix: "DO" },
  { re: /\binstead\s+(?:of|just)\b/i, prefix: "DO" },
  { re: /\bgive\s+a\s+gentle\b/i, prefix: "DO" },
];

interface Directive {
  prefix: string;
  text: string;
}

function extractUserText(message: Record<string, unknown>): string | null {
  const content = message?.content;
  if (!content) return null;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p: { type: string }) => p.type === "text")
      .map((p: { text: string }) => p.text)
      .join("\n");
  }
  return null;
}

function extractDirectives(transcriptText: string): Directive[] {
  const directives: Directive[] = [];
  const seen = new Set<string>();

  for (const line of transcriptText.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "user") continue;

    const text = extractUserText(entry.message as Record<string, unknown>);
    if (!text || text.length < 10 || text.length > 1000) continue;

    // Check each sentence for directive patterns
    const sentences = text.split(/[.!?\n]/).map((s) => s.trim()).filter(Boolean);
    for (const sentence of sentences) {
      if (sentence.length < 10 || sentence.length > 300) continue;

      for (const { re, prefix } of DIRECTIVE_RES) {
        if (!re.test(sentence)) continue;

        // Normalise the directive text
        const clean = sentence
          .replace(/^[-•*]\s*/, "")     // strip list markers
          .replace(/\s+/g, " ")          // collapse whitespace
          .trim();

        // Deduplicate within session
        const key = clean.toLowerCase().slice(0, 80);
        if (seen.has(key)) continue;
        seen.add(key);

        directives.push({ prefix, text: clean });
        break; // only one match per sentence
      }
    }
  }

  return directives.slice(0, 10); // cap at 10 per session
}

// ─── Memory file resolution ─────────────────────────────────────────────────

function projectKeyFromCwd(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

async function findProjectDir(cwd: string): Promise<string | null> {
  // Try the direct derivation first
  const derived = join(PROJECTS_DIR, projectKeyFromCwd(cwd));
  if (existsSync(derived)) return derived;

  // Fallback: scan project dirs for one that matches this CWD
  try {
    const dirs = await readdir(PROJECTS_DIR);
    for (const dir of dirs) {
      if (cwd.replace(/\//g, "-") === dir) return join(PROJECTS_DIR, dir);
    }
  } catch {}

  return null;
}

// ─── Format as prescriptive directives ──────────────────────────────────────

function formatDirective(d: Directive): string {
  if (d.prefix) return `- **${d.prefix}**: ${d.text}`;
  return `- ${d.text}`;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const ok = () => console.log(JSON.stringify({ ok: true }));

  try {
    const input = (await Bun.stdin.json()) as StopHookInput;

    // Note: we intentionally ignore stop_hook_active here. This hook is async
    // and never blocks, so it cannot cause the retry loops that flag guards against.
    // Skipping on stop_hook_active would prevent the hook from ever running in
    // sessions where other stop hooks block first (which is nearly every session).

    const projectDir = await findProjectDir(input.cwd);
    if (!projectDir) { ok(); return; }

    const memoryDir = join(projectDir, "memory");
    if (!existsSync(memoryDir)) { ok(); return; }

    const memoryFile = join(memoryDir, "MEMORY.md");

    // Find the transcript
    let transcriptPath = input.transcript_path;
    if (!transcriptPath && input.session_id) {
      const candidate = join(projectDir, `${input.session_id}.jsonl`);
      if (existsSync(candidate)) transcriptPath = candidate;
    }
    if (!transcriptPath || !existsSync(transcriptPath)) { ok(); return; }

    // Read transcript (last 500KB max to stay fast)
    const file = Bun.file(transcriptPath);
    const size = file.size;
    let transcriptText: string;
    if (size > 512_000) {
      // Read only the tail
      const buf = await file.arrayBuffer();
      transcriptText = new TextDecoder().decode(buf.slice(Math.max(0, size - 512_000)));
    } else {
      transcriptText = await file.text();
    }

    const directives = extractDirectives(transcriptText);
    if (directives.length === 0) { ok(); return; }

    // Read existing memory to avoid duplicates
    let existing = "";
    if (existsSync(memoryFile)) {
      existing = await Bun.file(memoryFile).text();
    }

    const existingLower = existing.toLowerCase();
    const newDirectives = directives.filter((d) => {
      // Check if the core content already appears in memory
      const core = d.text.toLowerCase().slice(0, 60);
      return !existingLower.includes(core);
    });

    if (newDirectives.length === 0) { ok(); return; }

    // Check line count won't exceed ~200
    const currentLines = existing.split("\n").length;
    const addingLines = newDirectives.length + 3; // header + blank + directives
    if (currentLines + addingLines > 200) { ok(); return; }

    // Append as prescriptive directives (no temporal language, no diary)
    let append = "\n\n## Confirmed Patterns\n\n";
    // If the section already exists, just append the bullets
    if (existing.includes("## Confirmed Patterns")) {
      append = "\n";
    }
    for (const d of newDirectives) {
      append += formatDirective(d) + "\n";
    }

    await Bun.write(memoryFile, existing + append);

    ok();
  } catch {
    ok();
  }
}

main();
