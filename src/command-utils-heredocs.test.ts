import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findNonCanonicalGitInvocation } from "./command-utils.ts"
import { runBashHook } from "./utils/test-utils.ts"

describe("Git invocation detection with heredocs (issue 871)", () => {
  test("ignores git prose inside quoted heredoc bodies", () => {
    const command = [
      "cat >> notes.md <<'MARKER'",
      "the fix was /usr/bin/git push --force-with-lease, then env git status",
      "MARKER",
    ].join("\n")
    expect(findNonCanonicalGitInvocation(command)).toBeNull()
  })

  test("ignores substitutions inside quoted heredoc bodies", () => {
    const command = [
      "cat >> notes.md <<'MARKER'",
      "V=$(env git status) and `git push origin main`",
      "MARKER",
    ].join("\n")
    expect(findNonCanonicalGitInvocation(command)).toBeNull()
  })

  test("still detects executable git in unquoted heredoc substitutions", () => {
    const command = ["cat <<MARKER", "log=$(git push origin main)", "MARKER"].join("\n")
    expect(findNonCanonicalGitInvocation(command)?.kind).toBe("shell-substitution")
  })

  test("still detects non-canonical git in command position after a heredoc", () => {
    const command = [
      "cat >> notes.md <<'MARKER'",
      "prose mentioning git push",
      "MARKER",
      "/usr/bin/git status",
    ].join("\n")
    expect(findNonCanonicalGitInvocation(command)?.kind).toBe("binary-path")
  })

  test.each([
    "printf \"<<'EOF'\ntext\"\n/usr/bin/git push origin main\nEOF",
    "cat <<'EOF'\nignore \\\nEOF\n/usr/bin/git push origin main\nEOF",
    "cat <<'EOF'\nEOF\n/usr/bin/git push origin main\nEOF",
    "echo ignored # <<'EOF'\n/usr/bin/git push origin main\nEOF",
    "printf '%s' \\<<'EOF'\n/usr/bin/git push origin main\nEOF",
    "(( 1 <<'EOF' ))\n/usr/bin/git push origin main\nEOF",
    "cat <<$'EOF'\nEOF\n/usr/bin/git push origin main\n$EOF",
  ])("preserves executable Git after misleading heredoc text: %s", (command) => {
    expect(findNonCanonicalGitInvocation(command)?.kind).toBe("binary-path")
  })

  test.each([
    ["cat <<'EOF' > notes.md", "EOF"],
    ['cat <<"END-MARK"', "END-MARK"],
    ["cat <<\\EOF", "EOF"],
    ['cat <<E"OF"', "EOF"],
    ["cat <<''", ""],
    ["cat <<'EOF' # output", "EOF"],
    ["cat <<'EOF' ; printf done", "EOF"],
  ])("accepts quoted delimiter syntax %s", (opener, delimiter) => {
    const command = [opener, "env git status", "$(git push origin main)", delimiter].join("\n")
    expect(findNonCanonicalGitInvocation(command)).toBeNull()
  })

  test.each([
    ["cat <<'EOF'", " EOF"],
    ["cat <<'EOF'", "\tEOF"],
    ["cat <<-'EOF'", " EOF"],
  ])("keeps indented non-delimiters inside %s", (opener, bodyLine) => {
    expect(
      findNonCanonicalGitInvocation([opener, "text", bodyLine, "env git status", "EOF"].join("\n"))
    ).toBeNull()
  })

  test("closes tab-stripped heredocs at a tab-indented delimiter", () => {
    const command = "cat <<-'EOF'\n\tenv git status\n\tEOF\n/usr/bin/git status"
    expect(findNonCanonicalGitInvocation(command)?.kind).toBe("binary-path")
  })

  test("consumes multiple bodies in declaration order", () => {
    const command = [
      "cat <<'FIRST' <<'SECOND'",
      "env git status",
      "FIRST",
      "$(git push origin main)",
      "SECOND",
    ].join("\n")
    expect(findNonCanonicalGitInvocation(command)).toBeNull()
    expect(findNonCanonicalGitInvocation(`${command}\n/usr/bin/git status`)?.kind).toBe(
      "binary-path"
    )
  })

  test("preserves substitutions in mixed unquoted and quoted heredocs", () => {
    const command = [
      "cat <<PLAIN <<'QUOTED'",
      "$(git push origin main)",
      "PLAIN",
      "env git status",
      "QUOTED",
    ].join("\n")
    expect(findNonCanonicalGitInvocation(command)?.kind).toBe("shell-substitution")
  })

  test("does not interpret heredoc declarations inside an unquoted body", () => {
    const command = [
      "cat <<PLAIN",
      "<<'QUOTED'",
      "$(git push origin main)",
      "QUOTED",
      "PLAIN",
    ].join("\n")
    expect(findNonCanonicalGitInvocation(command)?.kind).toBe("shell-substitution")
  })

  test("respects continued delimiter lines inside unquoted heredocs", () => {
    const command = [
      "cat <<PLAIN",
      "not a delimiter \\",
      "PLAIN",
      "<<'QUOTED'",
      "$(git push origin main)",
      "QUOTED",
      "PLAIN",
    ].join("\n")
    expect(findNonCanonicalGitInvocation(command)?.kind).toBe("shell-substitution")
  })

  test("ignores unterminated quoted heredoc text", () => {
    expect(findNonCanonicalGitInvocation("cat <<'EOF'\nenv git status")).toBeNull()
  })

  test("preserves quoted Git prose in commit messages and issue bodies", () => {
    expect(findNonCanonicalGitInvocation("git commit -m 'mention env git status'")).toBeNull()
    expect(
      findNonCanonicalGitInvocation('gh issue create --body "use /usr/bin/git status"')
    ).toBeNull()
  })

  test.each([
    "echo ${x:-<<'EOF'\ntext}\n/usr/bin/git push origin main\nEOF",
    "echo $(date)\ncat <<'EOF'\n'\nEOF\n/usr/bin/git push origin main",
    "true ＜＜'EOF'\n:\n/usr/bin/git push origin main\nEOF",
  ])("preserves executable Git around nested or Unicode syntax: %s", (command) => {
    expect(findNonCanonicalGitInvocation(command)?.kind).toBe("binary-path")
  })

  test.each([
    "bash",
    "/bin/sh",
    "env zsh",
    "cat | bash",
    "cat | env sh",
  ])("detects heredoc scripts interpreted by %s", (consumer) => {
    const [first, ...rest] = consumer.split(" | ")
    const header = [`${first} <<'EOF'`, ...rest].join(" | ")
    expect(findNonCanonicalGitInvocation(`${header}\ngit status\nEOF`)?.kind).toBe("nested-shell")
  })

  test.each([
    "echo bash",
    "cat <<'EOF'; bash -c true",
    "cat <<'EOF' # bash",
  ])("does not mistake shell names in unrelated text for a heredoc consumer: %s", (header) => {
    const command = header.includes("<<") ? header : `${header} <<'EOF'`
    expect(findNonCanonicalGitInvocation(`${command}\n/usr/bin/git status\nEOF`)).toBeNull()
  })

  test("literal environment assignments cannot affect following Git", () => {
    expect(
      findNonCanonicalGitInvocation("cat <<'EOF'\nexport PATH=/example\nEOF\ngit status")
    ).toBeNull()
  })

  test("quotes in unquoted heredoc bodies do not suppress command substitution", () => {
    expect(findNonCanonicalGitInvocation("cat <<EOF\n'$(git push origin main)'\nEOF")?.kind).toBe(
      "shell-substitution"
    )
  })

  test("unquoted heredoc prose is data, not a command", () => {
    expect(findNonCanonicalGitInvocation("cat <<EOF\nenv git status\nEOF")).toBeNull()
  })

  test("nested syntax does not disable literal heredoc masking", () => {
    expect(
      findNonCanonicalGitInvocation("echo $(date)\ncat <<'EOF'\n$(git push origin main)\nEOF")
    ).toBeNull()
  })

  test.each([
    "export GIT_EXTERNAL_DIFF=/example; cat <<EOF\n$(git diff)\nEOF",
    "cat <<EOF\n$(export GIT_EXEC_PATH=/example; git status)\nEOF",
  ])("retains unsafe environment policy for heredoc expansions: %s", (command) => {
    expect(findNonCanonicalGitInvocation(command)?.kind).toBe("unsafe-environment")
  })

  test.each([
    "\\$(git push origin main)",
    "<(git push origin main)",
  ])("ignores non-expanding heredoc data: %s", (body) => {
    expect(findNonCanonicalGitInvocation(`cat <<EOF\n${body}\nEOF`)).toBeNull()
  })

  test("file descriptor duplication does not hide a downstream shell", () => {
    expect(findNonCanonicalGitInvocation("cat <<'EOF' 2>&1 | bash\ngit status\nEOF")?.kind).toBe(
      "nested-shell"
    )
  })

  test("hook allows append-heredoc prose and still rejects executable Git", async () => {
    const header = `cat >> ${join(tmpdir(), "swiz-871-notes.md")} <<'EOF'`
    const literal = `${header}\nenv git status\n$(git push origin main)\nEOF`
    const allowed = await runBashHook("hooks/pretooluse-banned-commands.ts", literal)
    expect(allowed.decision).toBeUndefined()
    const denied = await runBashHook(
      "hooks/pretooluse-banned-commands.ts",
      `${literal}\n/usr/bin/git status`
    )
    expect(denied.decision).toBe("deny")
    expect(denied.reason).toContain("Invoke Git directly")
  })
})
