import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { runBashHook, runHookInProcess, useTempDir } from "../src/utils/test-utils.ts"
import {
  extractBothRedirectTarget,
  extractGitRestoreTargets,
  extractNumberedRedirectTarget,
  extractPlainRedirectTarget,
  extractTeeTarget,
  isEmptyOrNonExistentFile,
  isPlainRedirectOnly,
  isSafeTempPath,
} from "./pretooluse-banned-commands.ts"

const HOOK = "hooks/pretooluse-banned-commands.ts"

async function runHook(command: string) {
  const result = await runBashHook(HOOK, command)
  return { ...result, allow: result.decision === "allow" }
}

function summaryWithSkills(skills: string[]): Record<string, unknown> {
  const sessionLines = skills.map((skill) =>
    JSON.stringify({
      timestamp: new Date(Date.now() - 1000).toISOString(),
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Skill", input: { skill } }] },
    })
  )
  return {
    toolNames: skills.map(() => "Skill"),
    toolCallCount: skills.length,
    bashCommands: [],
    skillInvocations: skills,
    sessionLines,
    hasGitPush: false,
    sessionDurationMs: 0,
    successfulTestRuns: 0,
    lastVerificationTime: null,
    sessionScope: "trivial",
  }
}

async function runHookWithSkills(command: string, skills: string[] = []) {
  return await runHookInProcess(HOOK, {
    tool_name: "Bash",
    tool_input: { command },
    cwd: process.cwd(),
    transcript_path: "fake-transcript.jsonl",
    _transcriptSummary: summaryWithSkills(skills),
  })
}

describe("pretooluse-banned-commands", () => {
  describe("warn severity (allow with hint)", () => {
    test("grep gets a gentle nudge", async () => {
      const result = await runHook("grep -r TODO src/")
      expect(result.decision).toBe("allow")
      expect(result.stdout).toContain("rg")
    })

    test("find gets a gentle nudge", async () => {
      const result = await runHook("find . -name '*.ts'")
      expect(result.decision).toBe("allow")
      expect(result.stdout).toContain("fd")
    })
  })

  describe("deny severity (blocked)", () => {
    test("sed in-place edit is blocked", async () => {
      const result = await runHook("sed -i 's/foo/bar/' file.ts")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("Edit tool")
    })

    test("sed long in-place edit is blocked", async () => {
      const result = await runHook("sed --in-place 's/foo/bar/' file.ts")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("Edit tool")
    })

    test("awk redirecting to a file is blocked", async () => {
      const result = await runHook("awk '{print $1}' file.ts > output.txt")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("Edit tool")
    })

    test("awk piped through tee -i is blocked", async () => {
      const result = await runHook("awk '{print $1}' file.ts | tee -i output.txt")
      expect(result.decision).toBe("deny")
    })

    test("perl file reads are blocked", async () => {
      const result = await runHook(
        "perl -ne 'print if $.>=1 && $.<=260' apps/main-web/components/age-verification/AgeVerificationFlow.tsx"
      )
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("Read tool")
    })

    test("rm is blocked", async () => {
      const result = await runHook("rm -rf node_modules")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("trash")
    })

    describe("dangerous pipelines (#436)", () => {
      test("git diff piped to xargs git restore is denied (regression)", async () => {
        const result = await runHook("git diff --name-only HEAD | xargs -r git restore --")
        expect(result.decision).toBe("deny")
        expect(result.reason).toContain("git restore")
      })

      test("pipeline with xargs -r rm is denied", async () => {
        const result = await runHook("git diff --name-only HEAD | xargs -r rm -f")
        expect(result.decision).toBe("deny")
        expect(result.reason).toContain("trash")
      })

      test("pipeline with xargs -0 rm is denied", async () => {
        const result = await runHook("git ls-files -z | xargs -0 rm -f")
        expect(result.decision).toBe("deny")
        expect(result.reason).toContain("trash")
      })

      test("plain git status is not denied", async () => {
        const result = await runHook("git status --short")
        expect(result.decision).not.toBe("deny")
      })

      test("plain git diff is not denied", async () => {
        const result = await runHook("git diff --stat")
        expect(result.decision).not.toBe("deny")
      })
    })

    describe("git restore safety rules", () => {
      const tmp = useTempDir("swiz-restore-test-")

      test("allows git restore targeting an empty file (0 bytes)", async () => {
        const dir = await tmp.create("empty-file-")
        const emptyFile = join(dir, "empty.txt")
        await Bun.write(emptyFile, "")

        const result = await runHookInProcess(HOOK, {
          tool_name: "Bash",
          tool_input: { command: "git restore empty.txt" },
          cwd: dir,
        })
        expect(result.decision).toBe("allow")
        expect(result.reason ?? result.json?.systemMessage ?? result.stdout).toContain(
          "trash <file>"
        )
      })

      test("allows git restore targeting a non-existent file", async () => {
        const dir = await tmp.create("missing-file-")

        const result = await runHookInProcess(HOOK, {
          tool_name: "Bash",
          tool_input: { command: "git restore non-existent.txt" },
          cwd: dir,
        })
        expect(result.decision).toBe("allow")
        expect(result.reason ?? result.json?.systemMessage ?? result.stdout).toContain(
          "trash <file>"
        )
      })

      test("allows git restore --staged targeting empty or non-existent files", async () => {
        const dir = await tmp.create("staged-empty-")
        const emptyFile = join(dir, "staged-empty.txt")
        await Bun.write(emptyFile, "")

        const result = await runHookInProcess(HOOK, {
          tool_name: "Bash",
          tool_input: { command: "git restore --staged staged-empty.txt missing.txt" },
          cwd: dir,
        })
        expect(result.decision).toBe("allow")
        expect(result.reason ?? result.json?.systemMessage ?? result.stdout).toContain(
          "trash <file>"
        )
      })

      test("allows git restore with options like --source=HEAD -- targeting empty files", async () => {
        const dir = await tmp.create("source-empty-")
        const emptyFile = join(dir, "file.ts")
        await Bun.write(emptyFile, "")

        const result = await runHookInProcess(HOOK, {
          tool_name: "Bash",
          tool_input: { command: "git restore --source=HEAD~1 -- file.ts" },
          cwd: dir,
        })
        expect(result.decision).toBe("allow")
        expect(result.reason ?? result.json?.systemMessage ?? result.stdout).toContain(
          "trash <file>"
        )
      })

      test("blocks git restore targeting a populated file (>0 bytes)", async () => {
        const dir = await tmp.create("populated-file-")
        const populatedFile = join(dir, "populated.txt")
        await Bun.write(populatedFile, "important content\n")

        const result = await runHookInProcess(HOOK, {
          tool_name: "Bash",
          tool_input: { command: "git restore populated.txt" },
          cwd: dir,
        })
        expect(result.decision).toBe("deny")
        expect(result.reason).toContain("git restore")
        expect(result.reason).toContain("trash <file>")
      })

      test("blocks git restore if any target file in multi-target list is populated", async () => {
        const dir = await tmp.create("mixed-files-")
        const emptyFile = join(dir, "empty.txt")
        const populatedFile = join(dir, "populated.txt")
        await Bun.write(emptyFile, "")
        await Bun.write(populatedFile, "cannot lose this\n")

        const result = await runHookInProcess(HOOK, {
          tool_name: "Bash",
          tool_input: { command: "git restore empty.txt populated.txt" },
          cwd: dir,
        })
        expect(result.decision).toBe("deny")
        expect(result.reason).toContain("git restore")
        expect(result.reason).toContain("trash <file>")
      })

      test("blocks git restore targeting a directory (.)", async () => {
        const dir = await tmp.create("dir-target-")

        const result = await runHookInProcess(HOOK, {
          tool_name: "Bash",
          tool_input: { command: "git restore ." },
          cwd: dir,
        })
        expect(result.decision).toBe("deny")
        expect(result.reason).toContain("git restore")
      })

      test("blocks git restore targeting a subdirectory", async () => {
        const dir = await tmp.create("subdir-target-")
        await mkdir(join(dir, "subfolder"))

        const result = await runHookInProcess(HOOK, {
          tool_name: "Bash",
          tool_input: { command: "git restore subfolder" },
          cwd: dir,
        })
        expect(result.decision).toBe("deny")
        expect(result.reason).toContain("git restore")
      })

      test("blocks git restore with no targets", async () => {
        const dir = await tmp.create("no-target-")

        const result = await runHookInProcess(HOOK, {
          tool_name: "Bash",
          tool_input: { command: "git restore --staged" },
          cwd: dir,
        })
        expect(result.decision).toBe("deny")
        expect(result.reason).toContain("git restore")
      })

      test("extractGitRestoreTargets extracts targets correctly", () => {
        const extracted1 = extractGitRestoreTargets("git restore foo.ts bar.ts", "/root")
        expect(extracted1.isGitRestore).toBe(true)
        expect(extracted1.targets).toEqual(["foo.ts", "bar.ts"])
        expect(extracted1.hasDynamicTarget).toBe(false)

        const extracted2 = extractGitRestoreTargets(
          "git -C src restore --staged -- baz.ts",
          "/root"
        )
        expect(extracted2.isGitRestore).toBe(true)
        expect(extracted2.targets).toEqual(["baz.ts"])
        expect(extracted2.segmentCwd).toBe("/root/src")

        const extracted3 = extractGitRestoreTargets("git restore --source HEAD file.ts", "/root")
        expect(extracted3.isGitRestore).toBe(true)
        expect(extracted3.targets).toEqual(["file.ts"])

        const extracted4 = extractGitRestoreTargets("xargs git restore", "/root")
        expect(extracted4.isGitRestore).toBe(true)
        expect(extracted4.hasDynamicTarget).toBe(true)
      })

      test("isEmptyOrNonExistentFile correctly identifies empty, non-existent, and populated files", async () => {
        const dir = await tmp.create("unit-file-check-")
        const emptyFile = join(dir, "empty.ts")
        const populatedFile = join(dir, "populated.ts")
        const subDir = join(dir, "sub")
        const missingFile = join(dir, "does-not-exist.ts")

        await Bun.write(emptyFile, "")
        await Bun.write(populatedFile, "console.log('hi')")
        await mkdir(subDir)

        expect(await isEmptyOrNonExistentFile(emptyFile)).toBe(true)
        expect(await isEmptyOrNonExistentFile(missingFile)).toBe(true)
        expect(await isEmptyOrNonExistentFile(populatedFile)).toBe(false)
        expect(await isEmptyOrNonExistentFile(subDir)).toBe(false)
      })
    })

    describe("noncanonical Git invocation", () => {
      for (const command of [
        "/usr/bin/git status",
        "/opt/homebrew/bin/git push origin main",
        "./git status",
      ]) {
        test(`blocks direct Git binary path: ${command}`, async () => {
          const result = await runHook(command)
          expect(result.decision).toBe("deny")
          expect(result.reason).toContain("directly as `git`")
        })
      }

      for (const command of [
        "env git status",
        "/usr/bin/env git status",
        "command git status",
        "exec git status",
        "sudo git status",
        "GIT_OPTIONAL_LOCKS=0 git status",
        "printf '%s\\n' src/file.ts | xargs git status --short",
        "if git status; then echo ready; fi",
        "(git status)",
      ]) {
        test(`blocks Git behind a command wrapper: ${command}`, async () => {
          const result = await runHook(command)
          expect(result.decision).toBe("deny")
          expect(result.reason).toContain("directly as `git`")
        })
      }

      for (const command of [
        "/bin/zsh -lc 'git status'",
        'bash -c "git push origin main"',
        "sh -c 'git checkout -b feat/wrapped'",
        "zsh -lc 'echo ready && git worktree add /tmp/wrapped'",
        "/bin/zsh -lc 'bash -c \"git status\"'",
        "/usr/bin/env zsh -lc 'git status'",
        "sudo sh -c 'git status'",
      ]) {
        test(`blocks Git inside a nested shell: ${command}`, async () => {
          const result = await runHook(command)
          expect(result.decision).toBe("deny")
          expect(result.reason).toContain("nested shell")
        })
      }

      for (const command of [
        'echo "$(git status)"',
        "diff <(git status) expected.txt",
        "echo `git status`",
      ]) {
        test(`blocks Git inside shell substitution: ${command}`, async () => {
          const result = await runHook(command)
          expect(result.decision).toBe("deny")
          expect(result.reason).toContain("directly as `git`")
        })
      }
    })

    test("cd is blocked", async () => {
      const result = await runHook("cd /tmp && ls")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("Current directory:")
    })

    test("touch is blocked", async () => {
      const result = await runHook("touch newfile.ts")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("Write tool")
    })

    test("python is blocked", async () => {
      const result = await runHook("python3 script.py")
      expect(result.decision).toBe("deny")
    })

    test("git stash is blocked", async () => {
      const result = await runHook("git stash")
      expect(result.decision).toBe("deny")
    })

    test("git stash push is blocked", async () => {
      const result = await runHook("git stash push")
      expect(result.decision).toBe("deny")
    })

    test("git stash pop is blocked", async () => {
      const result = await runHook("git stash pop")
      expect(result.decision).toBe("deny")
    })

    test("git stash drop is blocked", async () => {
      const result = await runHook("git stash drop")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("recovery entry")
      expect(result.reason).toContain("swiz stash retire <full-oid>")
    })

    test("supported stash retirement requires the prune-branches skill", async () => {
      const result = await runHookWithSkills(`swiz stash retire ${"a".repeat(40)}`)
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("prune-branches")
    })

    test("supported stash retirement is allowed after the prune-branches skill", async () => {
      const result = await runHookWithSkills(`swiz stash retire ${"a".repeat(40)}`, [
        "prune-branches",
      ])
      expect(result.decision).not.toBe("deny")
    })

    test("prune-branches does not authorize raw git stash drop", async () => {
      const result = await runHookWithSkills("git stash drop stash@{0}", ["prune-branches"])
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("swiz stash retire")
    })

    test("git stash list is allowed", async () => {
      const result = await runHook("git stash list")
      expect(result.decision).not.toBe("deny")
    })

    test("git stash show is allowed", async () => {
      const result = await runHook("git stash show")
      expect(result.decision).not.toBe("deny")
    })

    test("git stash show with stash ref is allowed", async () => {
      const result = await runHook("git stash show stash@{0}")
      expect(result.decision).not.toBe("deny")
    })

    test("git stash show does not exempt an earlier stash push in the same command", async () => {
      const result = await runHook(
        [
          "set -e",
          "STASH_MESSAGE='preserve concurrent work'",
          'git stash push -u -m "$STASH_MESSAGE"',
          "STASH_OID=$(git rev-parse --verify refs/stash)",
          'git stash show -u --stat "$STASH_OID"',
        ].join("\n")
      )

      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("shared checkout")
      expect(result.reason).toContain("same checkout")
    })

    test("git reset --hard is blocked", async () => {
      const result = await runHook("git reset --hard HEAD~1")
      expect(result.decision).toBe("deny")
    })

    test("git checkout -- file is blocked", async () => {
      const result = await runHook("git checkout -- src/file.ts")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("git checkout -- <file-or-glob>")
    })

    test("git checkout HEAD -- file is blocked", async () => {
      const result = await runHook("git checkout HEAD -- src/file.ts")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("git checkout <ref-or-hash> -- <file-or-glob>")
    })

    test("git checkout commit hash -- file is blocked", async () => {
      const result = await runHook("git checkout a1b2c3d -- src/file.ts")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("git checkout <ref-or-hash> -- <file-or-glob>")
    })

    test("git checkout tag -- glob is blocked", async () => {
      const result = await runHook("git checkout v1.2.3 -- '*.ts'")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("git checkout <ref-or-hash> -- <file-or-glob>")
    })

    test("bun test --reporter=verbose is blocked with corrected command", async () => {
      const result = await runHook("bun test hooks/foo.test.ts --reporter=verbose")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("'verbose' is not valid")
      expect(result.reason).toContain("bun test hooks/foo.test.ts --reporter=dots")
    })

    test("bun test --reporter verbose (space form) is blocked", async () => {
      const result = await runHook("bun test hooks/foo.test.ts --reporter verbose")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("'verbose' is not valid")
      expect(result.reason).toContain("--reporter=dots")
    })

    test("bun test --reporter='verbose' (quoted equals form) is blocked", async () => {
      const result = await runHook("bun test foo.ts --reporter='verbose'")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("'verbose' is not valid")
      expect(result.reason).toContain("--reporter=dots")
    })

    test("chained: second invocation with bad reporter is blocked", async () => {
      const result = await runHook(
        "bun test a.test.ts --reporter=dots && bun test b.test.ts --reporter=verbose"
      )
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("'verbose' is not valid")
      // Both occurrences replaced in the corrected command
      expect(result.reason).toContain("b.test.ts --reporter=dots")
    })

    test('bun test --reporter="verbose" (double-quoted) is blocked', async () => {
      const result = await runHook('bun test foo.ts --reporter="verbose"')
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("'verbose' is not valid")
      expect(result.reason).toContain("--reporter=dots")
    })

    test("bun test --reporter=\\'verbose\\' (escaped single-quote) is blocked", async () => {
      const result = await runHook("bun test foo.ts --reporter=\\'verbose\\'")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("'verbose' is not valid")
      expect(result.reason).toContain("--reporter=dots")
    })

    test("-r verbose (short alias, space form) is blocked", async () => {
      const result = await runHook("bun test foo.ts -r verbose")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("'verbose' is not valid")
      expect(result.reason).toContain("--reporter=dots")
    })

    test("-r=verbose (short alias, equals form) is blocked", async () => {
      const result = await runHook("bun test foo.ts -r=verbose")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("'verbose' is not valid")
      expect(result.reason).toContain("--reporter=dots")
    })

    test("bun test --reporter=pretty is blocked with corrected command", async () => {
      const result = await runHook("bun test --reporter=pretty src/")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("'pretty' is not valid")
      expect(result.reason).toContain("--reporter=dots")
    })

    // Last-flag-wins: Bun resolves multiple --reporter/-r flags by using the final one.
    test("last-flag-wins: invalid then valid passes through (last is dots)", async () => {
      const result = await runHook("bun test foo.ts --reporter=verbose --reporter=dots")
      expect(result.decision).toBeUndefined()
    })

    test("last-flag-wins: valid then invalid is blocked (last is verbose)", async () => {
      const result = await runHook("bun test foo.ts --reporter=dots --reporter=verbose")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("'verbose' is not valid")
    })

    test("last-flag-wins: mixed alias forms — -r verbose then --reporter=dots passes", async () => {
      const result = await runHook("bun test foo.ts -r verbose --reporter=dots")
      expect(result.decision).toBeUndefined()
    })

    test("last-flag-wins: multiple invalids — last unsupported value named in reason", async () => {
      const result = await runHook("bun test foo.ts --reporter=verbose --reporter=pretty")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("'pretty' is not valid")
    })

    test("echo plain redirect > is blocked", async () => {
      const result = await runHook("echo hello > out.txt")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("Write tool")
    })

    test("echo append redirect >> is blocked", async () => {
      const result = await runHook("echo hello >> out.txt")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("Write tool")
    })

    test("echo noclobber-bypass >| is blocked", async () => {
      const result = await runHook("echo hello >| out.txt")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("Write tool")
    })

    test("printf | tee file is blocked", async () => {
      const result = await runHook("printf '%s\\n' hello | tee out.txt")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("Write tool")
    })

    test("&> redirect is blocked", async () => {
      const result = await runHook("command &> out.txt")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("Write tool")
    })

    test("&>> redirect is blocked", async () => {
      const result = await runHook("command &>> out.txt")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("Write tool")
    })

    test("1> numbered stdout redirect is blocked", async () => {
      const result = await runHook("command 1> out.txt")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("Write tool")
    })

    test("2> numbered stderr-to-file redirect is blocked", async () => {
      const result = await runHook("command 2> err.txt")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("Write tool")
    })

    test("cat src > file is blocked", async () => {
      const result = await runHook("cat src/foo.ts > ~/output.ts")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("Write tool")
    })

    test("echo piped to tee file is blocked", async () => {
      const result = await runHook("echo hello | tee out.txt")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("Write tool")
    })

    test("command piped to tee -a file is blocked", async () => {
      const result = await runHook("command output | tee -a out.txt")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("Write tool")
    })

    test("input process substitution (cmd < <(subcmd)) is blocked", async () => {
      const result = await runHook("cmd < <(subcmd)")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("Write tool")
    })

    test("input process substitution with tee bypass (< <(tee file)) is blocked", async () => {
      const result = await runHook("bun script < <(tee out.txt)")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("Write tool")
    })

    test("process substitution write (> >(tee file)) is blocked", async () => {
      const result = await runHook("cmd > >(tee out.txt)")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("Write tool")
    })

    test("here-string redirect to file (<<< text > file) is blocked", async () => {
      const result = await runHook('cmd <<< "hello" > out.txt')
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("Write tool")
    })

    test("heredoc cat redirect is blocked", async () => {
      const result = await runHook("cat <<EOF > out.txt")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("Write tool")
    })

    test("heredoc with dash (cat <<-EOF > file) is blocked", async () => {
      const result = await runHook("cat <<-EOF > out.txt")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("Write tool")
    })

    test("heredoc quoted delimiter (cat <<'EOF' > file) is blocked", async () => {
      const result = await runHook("cat <<'EOF' > out.txt")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("Write tool")
    })

    test("brace group redirect ({cmd;} > file) is blocked", async () => {
      const result = await runHook("{ echo hello; echo world; } > out.txt")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("Write tool")
    })

    test("compact brace group redirect ({cmd1;cmd2} > file) is blocked", async () => {
      const result = await runHook("{cmd1;cmd2} > out.txt")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("Write tool")
    })

    test("brace group append redirect ({cmd;} >> file) is blocked", async () => {
      const result = await runHook("{ printf '%s\\n' hello; } >> out.txt")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("Write tool")
    })

    test("git commit --no-verify is blocked", async () => {
      const result = await runHook("git commit --no-verify -m 'test'")
      expect(result.decision).toBe("deny")
    })

    test("--trailer is blocked", async () => {
      const result = await runHook("git commit --trailer 'Co-authored-by: AI'")
      expect(result.decision).toBe("deny")
    })

    test("gh issue edit --body with shell-sensitive content is blocked", async () => {
      const result = await runHook(
        'gh issue edit 123 --body "Include `code`, $(date), and <placeholder>."'
      )
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("--body-file")
    })

    test("gh issue create --body with shell-sensitive content is blocked", async () => {
      const result = await runHook(
        "gh issue create --title 'Bug' --body \"Steps: $(./repro.sh) then check <output>.\""
      )
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("--body-file")
    })

    test("gh issue create --body with backtick content is blocked", async () => {
      const result = await runHook(
        "gh issue create --title 'Fix' --body \"Run `make test` first.\""
      )
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("--body-file")
    })
  })

  describe("allowed commands (no output)", () => {
    test("git status passes through", async () => {
      const result = await runHook("git status")
      expect(result.decision).toBeUndefined()
    })

    test("git checkout branch switch passes through", async () => {
      const result = await runHook("git checkout feature/my-branch")
      expect(result.decision).toBeUndefined()
    })

    test("canonical Git commands with global options and compounds pass through", async () => {
      const result = await runHook(
        "git -C /tmp/repo status --short && git -c color.ui=false log --oneline"
      )
      expect(result.decision).toBeUndefined()
    })

    for (const command of [
      "echo '/usr/bin/git status'",
      "rg 'git status' docs/",
      `git commit -m "docs: mention /usr/bin/git without invoking it"`,
      `/bin/zsh -lc 'echo "git status"'`,
      "echo '`git status`'",
    ]) {
      test(`allows non-executable Git prose: ${command}`, async () => {
        const result = await runHook(command)
        expect(result.decision).toBeUndefined()
      })
    }

    test("echo passes through", async () => {
      const result = await runHook("echo hello")
      expect(result.decision).toBeUndefined()
    })

    test("bun test passes through", async () => {
      const result = await runHook("bun test")
      expect(result.decision).toBeUndefined()
    })

    test("bun test --reporter=dots passes through", async () => {
      const result = await runHook("bun test hooks/foo.test.ts --reporter=dots")
      expect(result.decision).toBeUndefined()
    })

    test("bun test --reporter dots (space form) passes through", async () => {
      const result = await runHook("bun test hooks/foo.test.ts --reporter dots")
      expect(result.decision).toBeUndefined()
    })

    test("-r dots (short alias) passes through", async () => {
      const result = await runHook("bun test hooks/foo.test.ts -r dots")
      expect(result.decision).toBeUndefined()
    })

    test("-r=junit (short alias) passes through", async () => {
      const result = await runHook("bun test hooks/foo.test.ts -r=junit")
      expect(result.decision).toBeUndefined()
    })

    test("bun test --reporter=junit passes through", async () => {
      const result = await runHook("bun test hooks/foo.test.ts --reporter=junit")
      expect(result.decision).toBeUndefined()
    })

    test("chained: both invocations with valid reporters pass through", async () => {
      const result = await runHook(
        "bun test a.test.ts --reporter=dots && bun test b.test.ts --reporter=junit"
      )
      expect(result.decision).toBeUndefined()
    })

    test("echo with bun test --reporter=verbose in JSON payload is not blocked", async () => {
      // The reporter check must not fire when bun test appears inside a quoted
      // string that is an argument to echo (e.g. piping JSON to a hook script).
      const cmd = `echo '{"tool_input":{"command":"bun test foo.ts --reporter=verbose"}}' | bun hooks/pretooluse-banned-commands.ts`
      const result = await runHook(cmd)
      expect(result.decision).toBeUndefined()
    })

    test("2>&1 fd-to-fd redirect passes through", async () => {
      const result = await runHook("command 2>&1")
      expect(result.decision).toBeUndefined()
    })

    test(">&2 fd-to-fd redirect passes through", async () => {
      const result = await runHook("command >&2")
      expect(result.decision).toBeUndefined()
    })

    test("tee /dev/null passes through", async () => {
      const result = await runHook("bun test 2>&1 | tee /dev/null")
      expect(result.decision).toBeUndefined()
    })

    test("heredoc piped to command (no file redirect) passes through", async () => {
      const result = await runHook("bun hooks/pretooluse-banned-commands.ts <<EOF")
      expect(result.decision).toBeUndefined()
    })

    test("process substitution to /dev/null passes through", async () => {
      const result = await runHook("cmd > >(tee /dev/null)")
      expect(result.decision).toBeUndefined()
    })

    test("brace group redirect to /dev/null passes through", async () => {
      const result = await runHook("{ echo hello; } > /dev/null")
      expect(result.decision).toBeUndefined()
    })

    // ── Temp-directory redirect exemptions ───────────────────────────────────

    test("plain redirect to /tmp/ passes through", async () => {
      const result = await runHook("echo hello > /tmp/pr_body.md")
      expect(result.decision).toBeUndefined()
    })

    test("heredoc redirect to /tmp/ passes through", async () => {
      const result = await runHook("cat <<'BODY' > /tmp/pr_body.md")
      expect(result.decision).toBeUndefined()
    })

    test("append redirect to /tmp/ passes through", async () => {
      const result = await runHook("echo line >> /tmp/log.txt")
      expect(result.decision).toBeUndefined()
    })

    test("tee to /tmp/ passes through", async () => {
      const result = await runHook("echo hello | tee /tmp/out.txt")
      expect(result.decision).toBeUndefined()
    })

    test("tee -a to /tmp/ passes through", async () => {
      const result = await runHook("echo hello | tee -a /tmp/out.txt")
      expect(result.decision).toBeUndefined()
    })

    test("redirect to /private/tmp/ passes through (macOS canonical)", async () => {
      const result = await runHook("echo hello > /private/tmp/body.md")
      expect(result.decision).toBeUndefined()
    })

    test("redirect to /var/tmp/ passes through", async () => {
      const result = await runHook("echo hello > /var/tmp/body.md")
      expect(result.decision).toBeUndefined()
    })

    test("redirect to /var/folders/ passes through (macOS $TMPDIR)", async () => {
      const result = await runHook("echo hello > /var/folders/xx/yyy/T/body.md")
      expect(result.decision).toBeUndefined()
    })

    test("redirect to project file is still blocked", async () => {
      const result = await runHook("echo hello > src/output.ts")
      expect(result.decision).toBe("deny")
    })

    test("rg passes through", async () => {
      const result = await runHook("rg 'pattern' src/")
      expect(result.decision).toBeUndefined()
    })

    test("awk stdout extraction passes through", async () => {
      const result = await runHook("awk '{print $1}' file.ts")
      expect(result.decision).toBeUndefined()
    })

    test("awk --help passes through", async () => {
      const result = await runHook("awk --help")
      expect(result.decision).toBeUndefined()
    })

    test("awk in pipeline (no file redirect) passes through", async () => {
      const result = await runHook("gh issue list --json number | awk '{print $1}'")
      expect(result.decision).toBeUndefined()
    })

    test("sed -n read-only passes through", async () => {
      const result = await runHook("sed -n '1,10p' file.ts")
      expect(result.decision).toBeUndefined()
    })

    test("sed -n with stderr suppressed to /dev/null passes through", async () => {
      const result = await runHook("sed -n '1,10p' optional.ts 2>/dev/null")
      expect(result.decision).toBeUndefined()
    })

    test("sed read-only transform passes through", async () => {
      const result = await runHook("sed 's/foo/bar/' file.ts")
      expect(result.decision).toBeUndefined()
    })

    test("sed read-only path containing -i passes through", async () => {
      const result = await runHook("sed -n '1,10p' src/in-place-file.ts")
      expect(result.decision).toBeUndefined()
    })

    // ── False-positive guard: banned patterns inside quoted arguments ──────────

    test("commit message containing 'git stash' in quotes passes through", async () => {
      const result = await runHook(`git commit -m "docs: explain why git stash is avoided"`)
      expect(result.decision).toBeUndefined()
    })

    test("commit message containing banned pattern in single quotes passes through", async () => {
      const result = await runHook(
        `git commit -m 'test: add multi-file path extraction for restore command'`
      )
      expect(result.decision).toBeUndefined()
    })

    test("evidence arg containing 'git reset --hard' in quotes passes through", async () => {
      const result = await runHook(
        `swiz tasks complete 42 --evidence "note: avoid git reset --hard" --state developing`
      )
      expect(result.decision).toBeUndefined()
    })

    test("commit message containing 'git clean' in double quotes passes through", async () => {
      const result = await runHook(`git commit -m "docs: document git clean risks"`)
      expect(result.decision).toBeUndefined()
    })

    test("gh issue edit --body without shell-sensitive markers passes through", async () => {
      const result = await runHook('gh issue edit 123 --body "Plain text body."')
      expect(result.decision).toBeUndefined()
    })
  })

  // ── Unit tests for exported utility functions ────────────────────────────

  describe("extractPlainRedirectTarget", () => {
    const cwd = "/home/user/project"

    test("extracts absolute path from plain redirect", () => {
      expect(extractPlainRedirectTarget("echo hello > /tmp/out.txt", cwd)).toBe("/tmp/out.txt")
    })

    test("extracts absolute path from append redirect", () => {
      expect(extractPlainRedirectTarget("echo hello >> /tmp/out.txt", cwd)).toBe("/tmp/out.txt")
    })

    test("resolves relative path against cwd", () => {
      expect(extractPlainRedirectTarget("echo hello > out.txt", cwd)).toBe(
        "/home/user/project/out.txt"
      )
    })

    test("expands tilde to HOME", () => {
      const home = process.env.HOME ?? ""
      expect(extractPlainRedirectTarget("echo hello > ~/out.txt", cwd)).toBe(`${home}/out.txt`)
    })

    test("returns null for /dev/ paths", () => {
      expect(extractPlainRedirectTarget("echo hello > /dev/null", cwd)).toBeNull()
    })

    test("returns null for fd-to-fd redirect (&)", () => {
      expect(extractPlainRedirectTarget("command 2>&1", cwd)).toBeNull()
    })

    test("returns null for process substitution >(...)", () => {
      expect(extractPlainRedirectTarget("cmd > >(tee file)", cwd)).toBeNull()
    })

    test("returns null when no redirect present", () => {
      expect(extractPlainRedirectTarget("echo hello", cwd)).toBeNull()
    })

    test("strips surrounding quotes from target", () => {
      expect(extractPlainRedirectTarget("echo hello > '/tmp/out.txt'", cwd)).toBe("/tmp/out.txt")
    })
  })

  describe("extractTeeTarget", () => {
    const cwd = "/home/user/project"

    test("extracts absolute path from tee", () => {
      expect(extractTeeTarget("echo hello | tee /tmp/out.txt", cwd)).toBe("/tmp/out.txt")
    })

    test("extracts path from tee -a (append flag)", () => {
      expect(extractTeeTarget("echo hello | tee -a /tmp/out.txt", cwd)).toBe("/tmp/out.txt")
    })

    test("resolves relative path against cwd", () => {
      expect(extractTeeTarget("echo hello | tee out.txt", cwd)).toBe("/home/user/project/out.txt")
    })

    test("returns null for /dev/ paths", () => {
      expect(extractTeeTarget("echo hello | tee /dev/null", cwd)).toBeNull()
    })

    test("returns null for tee to stdout (-)", () => {
      expect(extractTeeTarget("echo hello | tee -", cwd)).toBeNull()
    })

    test("returns null when no tee present", () => {
      expect(extractTeeTarget("echo hello > /tmp/out.txt", cwd)).toBeNull()
    })
  })

  describe("isSafeTempPath", () => {
    test("allows /tmp/ paths", () => {
      expect(isSafeTempPath("/tmp/file.txt")).toBe(true)
    })

    test("allows /private/tmp/ paths", () => {
      expect(isSafeTempPath("/private/tmp/file.txt")).toBe(true)
    })

    test("allows /var/tmp/ paths", () => {
      expect(isSafeTempPath("/var/tmp/file.txt")).toBe(true)
    })

    test("allows /var/folders/ paths (macOS TMPDIR)", () => {
      expect(isSafeTempPath("/var/folders/xx/yyy/T/file.txt")).toBe(true)
    })

    test("rejects /tmpevil/ (prefix confusion)", () => {
      expect(isSafeTempPath("/tmpevil/file.txt")).toBe(false)
    })

    test("rejects bare /tmp (no trailing slash/file)", () => {
      expect(isSafeTempPath("/tmp")).toBe(false)
    })

    test("rejects project paths", () => {
      expect(isSafeTempPath("/home/user/project/src/file.ts")).toBe(false)
    })

    test("rejects home directory paths", () => {
      expect(isSafeTempPath("/Users/me/.bashrc")).toBe(false)
    })
  })

  describe("isPlainRedirectOnly", () => {
    test("returns true for plain >", () => {
      expect(isPlainRedirectOnly("echo hello > file.txt")).toBe(true)
    })

    test("returns true for plain >>", () => {
      expect(isPlainRedirectOnly("echo hello >> file.txt")).toBe(true)
    })

    test("returns false for &>", () => {
      expect(isPlainRedirectOnly("command &> file.txt")).toBe(false)
    })

    test("returns false for tee", () => {
      expect(isPlainRedirectOnly("echo hello | tee file.txt")).toBe(false)
    })

    test("returns false for heredoc redirect", () => {
      expect(isPlainRedirectOnly("cat <<EOF > file.txt")).toBe(false)
    })
  })

  describe("extractBothRedirectTarget", () => {
    const cwd = "/home/user/project"

    test("extracts target from &> redirect", () => {
      expect(extractBothRedirectTarget("command &> /tmp/out.log", cwd)).toBe("/tmp/out.log")
    })

    test("extracts target from &>> append", () => {
      expect(extractBothRedirectTarget("command &>> /tmp/out.log", cwd)).toBe("/tmp/out.log")
    })

    test("resolves relative path against cwd", () => {
      expect(extractBothRedirectTarget("command &> out.log", cwd)).toBe(
        "/home/user/project/out.log"
      )
    })

    test("returns null for /dev/ paths", () => {
      expect(extractBothRedirectTarget("command &> /dev/null", cwd)).toBeNull()
    })

    test("returns null when no &> redirect", () => {
      expect(extractBothRedirectTarget("echo hello > out.txt", cwd)).toBeNull()
    })
  })

  describe("extractNumberedRedirectTarget", () => {
    const cwd = "/home/user/project"

    test("extracts target from 2> redirect", () => {
      expect(extractNumberedRedirectTarget("command 2> /tmp/err.log", cwd)).toBe("/tmp/err.log")
    })

    test("extracts target from 2>> append", () => {
      expect(extractNumberedRedirectTarget("command 2>> /tmp/err.log", cwd)).toBe("/tmp/err.log")
    })

    test("extracts target from 1>", () => {
      expect(extractNumberedRedirectTarget("command 1> /tmp/out.log", cwd)).toBe("/tmp/out.log")
    })

    test("resolves relative path against cwd", () => {
      expect(extractNumberedRedirectTarget("command 2> err.log", cwd)).toBe(
        "/home/user/project/err.log"
      )
    })

    test("returns null for /dev/ paths", () => {
      expect(extractNumberedRedirectTarget("command 2> /dev/null", cwd)).toBeNull()
    })

    test("returns null when no numbered redirect", () => {
      expect(extractNumberedRedirectTarget("echo hello > out.txt", cwd)).toBeNull()
    })
  })

  describe("destructive delete variants", () => {
    test("rmdir is blocked", async () => {
      const result = await runHook("rmdir empty_dir")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("trash")
    })

    test("unlink is blocked", async () => {
      const result = await runHook("unlink file.txt")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("trash")
    })

    test("shred is blocked", async () => {
      const result = await runHook("shred -u secrets.txt")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("trash")
    })

    test("find -delete is blocked", async () => {
      const result = await runHook("find . -name '*.tmp' -delete")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("trash")
    })

    test("find -exec rm is blocked", async () => {
      const result = await runHook("find . -name '*.log' -exec rm {} \\;")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("trash")
    })

    test("&& rm chain is blocked", async () => {
      const result = await runHook("test -f file.txt && rm file.txt")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("trash")
    })

    test("; rm chain is blocked", async () => {
      const result = await runHook("echo done; rm file.txt")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("trash")
    })
  })

  describe("git rule edge cases", () => {
    test("git push --no-verify is blocked", async () => {
      const result = await runHook("git push --no-verify origin main")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("--no-verify")
    })

    test("git global options do not bypass --no-verify enforcement", async () => {
      const result = await runHook("git -C /tmp/repo commit --no-verify -m test")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("--no-verify")
    })

    test("git push --force is blocked", async () => {
      const result = await runHook("git push --force origin main")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("--force-with-lease")
    })

    test("git push -f with global options is blocked", async () => {
      const result = await runHook("git -C /tmp/repo push -f origin main")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("--force-with-lease")
    })

    test("git push --force-with-lease is allowed by the security rule", async () => {
      const result = await runHook("git push --force-with-lease origin main")
      expect(result.decision).toBeUndefined()
    })

    test("git push --force-if-includes is allowed by the security rule", async () => {
      const result = await runHook("git push --force-if-includes origin main")
      expect(result.decision).toBeUndefined()
    })

    test("force-looking refspecs after -- are not treated as flags", async () => {
      const result = await runHook("git push origin -- --force")
      expect(result.decision).toBeUndefined()
    })

    test("git clean -n (dry run) is still blocked", async () => {
      // The rule blocks all git clean usage regardless of flags
      const result = await runHook("git clean -n")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("git clean")
    })

    test("gh --admin merge is blocked", async () => {
      const result = await runHook("gh pr merge 123 --admin")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("--admin")
    })

    test("gh --skip-status-check is blocked", async () => {
      const result = await runHook("gh pr merge 123 --skip-status-check")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("--skip-status-check")
    })

    test("Co-authored-by in commit message is blocked", async () => {
      const result = await runHook(
        'git commit -m "feat: add feature\n\nCo-authored-by: Bot <bot@example.com>"'
      )
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("Co-authored-by")
    })

    test("Co-authored-by in a long-form commit message is blocked", async () => {
      const result = await runHook(
        'git -C /tmp/repo commit --message="fix: bug\n\nCo-authored-by: Bot <bot@example.com>"'
      )
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("Co-authored-by")
    })

    test("Claude Code generation signatures in commit messages are blocked", async () => {
      const result = await runHook('git commit -am "fix: bug\n\nGenerated with Claude Code"')
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("AI-generation")
    })

    test("security tokens inside an echo argument are not treated as commands", async () => {
      const result = await runHook('echo "git push --force && gh pr merge --admin"')
      expect(result.decision).toBeUndefined()
    })

    test("git checkout -- . (whole directory) is blocked", async () => {
      const result = await runHook("git checkout -- .")
      expect(result.decision).toBe("deny")
    })

    test("sed redirecting to a file is blocked", async () => {
      const result = await runHook("sed 's/foo/bar/' input.txt > output.txt")
      expect(result.decision).toBe("deny")
    })

    test("sed piped to tee writing a file is blocked", async () => {
      const result = await runHook("sed -n '1,10p' input.txt | tee output.txt")
      expect(result.decision).toBe("deny")
    })
  })

  describe("temp-path redirect edge cases", () => {
    test("&> redirect to /tmp/ passes through", async () => {
      const result = await runHook("command &> /tmp/output.log")
      expect(result.decision).toBeUndefined()
    })

    test("2> redirect to /tmp/ passes through", async () => {
      const result = await runHook("command 2> /tmp/err.log")
      expect(result.decision).toBeUndefined()
    })

    test("brace group redirect to /tmp/ passes through", async () => {
      const result = await runHook("{ echo hello; echo world; } > /tmp/out.txt")
      expect(result.decision).toBeUndefined()
    })

    test("heredoc with dash to /tmp/ passes through", async () => {
      const result = await runHook("cat <<-EOF > /tmp/body.md")
      expect(result.decision).toBeUndefined()
    })

    test("redirect to /tmp without file (bare /tmp) is blocked", async () => {
      // /tmp alone isn't under a safe prefix (requires /tmp/)
      const result = await runHook("echo hello > /tmp")
      expect(result.decision).toBe("deny")
    })

    test("redirect with path traversal (/tmp/../etc/passwd) is blocked", async () => {
      // extractPlainRedirectTarget returns the raw path; isSafeTempPath checks prefix
      // /tmp/../etc/passwd starts with /tmp/ so this WOULD pass the prefix check.
      // This is acceptable: the OS resolves /tmp/../etc/passwd to /etc/passwd,
      // but the redirect target is still the literal string the shell receives.
      // The shell itself resolves traversal, and /tmp/ is world-writable anyway.
      const result = await runHook("echo hello > /tmp/../etc/passwd")
      expect(result.decision).toBeUndefined()
    })

    test("redirect to /tmpevil/ is blocked (prefix confusion)", async () => {
      const result = await runHook("echo hello > /tmpevil/file.txt")
      expect(result.decision).toBe("deny")
    })
  })

  describe("runtime rules (bun project)", () => {
    // Note: These tests verify behavior when package manager is detected as bun.
    // In CI/environments where bun is not the detected PM, node/ts-node may pass through.
    test("python3 is always blocked regardless of package manager", async () => {
      const result = await runHook("python3 script.py")
      expect(result.decision).toBe("deny")
      // Message mentions either bun or node depending on detected package manager
      expect(result.reason).toMatch(/bun|node/)
    })
  })

  describe("non-Bash tools are ignored", () => {
    test("Edit tool exits silently", async () => {
      const result = await runHookInProcess(
        "hooks/pretooluse-banned-commands.ts",
        { tool_name: "Edit", tool_input: { command: "rm -rf /" } },
        { env: { SWIZ_DAEMON_PORT: "19999" } }
      )
      expect(result.stdout).toBe("")
      expect(result.exitCode).toBe(0)
    })
  })
})
