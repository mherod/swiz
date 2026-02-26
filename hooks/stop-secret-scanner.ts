#!/usr/bin/env bun
// Stop hook: Block stop if secrets/credentials detected in recent commits

import { git, isGitRepo, blockStop, type StopHookInput } from "./hook-utils.ts";

export {};

const PRIVATE_KEY_RE = /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY/i;
const TOKEN_RE = /AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{36}|ghs_[a-zA-Z0-9]{36}|xox[baprs]-[0-9A-Za-z]{10,}|sk-[a-zA-Z0-9]{32,}|sk_live_[a-zA-Z0-9]{24,}|rk_live_[a-zA-Z0-9]{24,}/i;
const GENERIC_SECRET_RE = /(api_?key|api_?secret|auth_?token|access_?token|secret_?key|private_?key|password|passwd|client_?secret)\s*[:=]\s*["'][^"']{8,}["']/i;
const GENERIC_EXCLUDE_RE = /example|placeholder|your[_-]|<.*>|xxxx|test|fake|dummy|replace|env\./i;

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as StopHookInput;
  const cwd = input.cwd;

  if (!(await isGitRepo(cwd))) return;

  const diff = (await git(["diff", "HEAD~10..HEAD"], cwd)) || (await git(["diff", "HEAD"], cwd));
  if (!diff) return;

  const findings: string[] = [];

  for (const line of diff.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;

    if (PRIVATE_KEY_RE.test(line)) {
      findings.push(line.slice(0, 120));
    } else if (TOKEN_RE.test(line)) {
      findings.push(line.slice(0, 120));
    } else if (GENERIC_SECRET_RE.test(line) && !GENERIC_EXCLUDE_RE.test(line)) {
      findings.push(line.slice(0, 120));
    }

    if (findings.length >= 10) break;
  }

  if (findings.length === 0) return;

  let reason = "Potential secrets detected in recent commits.\n\n";
  reason += "Suspicious lines:\n";
  for (const f of findings) reason += `  ${f}\n`;
  reason += "\nReview and remove secrets before stopping. If these are false positives, ensure values come from environment variables, not hardcoded strings.";

  blockStop(reason);
}

main();
