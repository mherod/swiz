#!/usr/bin/env bun
// Stop hook: Block stop if large files (>500KB) were committed without LFS

import { git, isGitRepo, blockStop, type StopHookInput } from "./hook-utils.ts";

export {};

const SIZE_LIMIT_KB = 500;

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as StopHookInput;
  const cwd = input.cwd;

  if (!(await isGitRepo(cwd))) return;

  // List files added in the last 10 commits
  const addedRaw = await git(["log", "--diff-filter=A", "--name-only", "--format=", "HEAD~10..HEAD"], cwd);
  if (!addedRaw) return;

  const addedFiles = addedRaw.split("\n").filter(Boolean);
  const largeFiles: string[] = [];

  for (const filePath of addedFiles) {
    // Get the blob hash for this file in the latest commit that touched it
    const treeEntry = await git(["ls-tree", "HEAD", "--", filePath], cwd);
    if (!treeEntry) continue;

    const parts = treeEntry.split(/\s+/);
    const blobHash = parts[2];
    if (!blobHash || blobHash === "0000000000000000000000000000000000000000") continue;

    // Get blob size
    const sizeStr = await git(["cat-file", "-s", blobHash], cwd);
    const sizeKb = Math.floor(parseInt(sizeStr) / 1024);
    if (isNaN(sizeKb) || sizeKb < SIZE_LIMIT_KB) continue;

    // Check if tracked by LFS
    const gitattributes = await git(["show", "HEAD:.gitattributes"], cwd);
    if (gitattributes && gitattributes.includes("filter=lfs")) {
      const escaped = filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(escaped).test(gitattributes)) continue;
    }

    largeFiles.push(`${sizeKb}KB — ${filePath}`);
    if (largeFiles.length >= 10) break;
  }

  if (largeFiles.length === 0) return;

  let reason = `Large files (>${SIZE_LIMIT_KB}KB) committed without Git LFS tracking.\n\n`;
  reason += "Files:\n";
  for (const f of largeFiles) reason += `  ${f}\n`;
  reason += "\nConsider adding these to Git LFS or removing them from the repository. Large committed files bloat git history permanently.";

  blockStop(reason);
}

main();
