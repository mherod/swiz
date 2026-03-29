import { describe, expect, test } from "bun:test"
import { runBashHook } from "../src/utils/test-utils.ts"

const HOOK = "hooks/pretooluse-banned-commands.ts"

async function runHook(command: string) {
  const result = await runBashHook(HOOK, command)
  return { ...result, allow: result.decision === "allow" }
}

describe("pretooluse-banned-commands", () => {
  describe("warn severity (allow with hint)", () => {
    test("grep gets a gentle nudge", async () => {
      const result = await runHook("grep -r TODO src/")
      expect(result.decision).toBe("allow")
      expect(result.reason).toContain("rg")
    })

    test("find gets a gentle nudge", async () => {
      const result = await runHook("find . -name '*.ts'")
      expect(result.decision).toBe("allow")
      expect(result.reason).toContain("fd")
    })
  })

  describe("deny severity (blocked)", () => {
    test("sed is blocked", async () => {
      const result = await runHook("sed -i 's/foo/bar/' file.ts")
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

    test("rm is blocked", async () => {
      const result = await runHook("rm -rf node_modules")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("trash")
    })

    test("cd is blocked", async () => {
      const result = await runHook("cd /tmp && ls")
      expect(result.decision).toBe("deny")
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
      const result = await runHook("cat src/foo.ts > /tmp/foo.ts")
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

  describe("non-Bash tools are ignored", () => {
    test("Edit tool exits silently", async () => {
      const payload = JSON.stringify({ tool_name: "Edit", tool_input: { command: "rm -rf /" } })
      const proc = Bun.spawn(["bun", "hooks/pretooluse-banned-commands.ts"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, SWIZ_DAEMON_PORT: "19999" },
      })
      void proc.stdin.write(payload)
      void proc.stdin.end()
      const out = await new Response(proc.stdout).text()
      await proc.exited
      expect(out.trim()).toBe("")
      expect(proc.exitCode).toBe(0)
    })
  })
})
