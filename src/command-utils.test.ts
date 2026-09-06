import { describe, expect, test } from "bun:test"
import {
  bunTestArgSegments,
  findNonCanonicalGitInvocation,
  isSingleFileBunTestArgs,
} from "./command-utils.ts"

describe("bunTestArgSegments", () => {
  test("extracts real bun test invocations from shell segments", () => {
    expect(bunTestArgSegments("rg foo hooks | bun test && bun test src/foo.test.ts")).toEqual([
      "",
      " src/foo.test.ts",
    ])
  })

  test("ignores quoted bun test text", () => {
    expect(bunTestArgSegments('rg -v "bun test" file.ts; grep "|bun test" hooks/*.ts')).toEqual([])
  })

  test("normalizes backslash-newline continuations", () => {
    expect(bunTestArgSegments("bun \\\n  test --concurrent")).toEqual([" --concurrent"])
  })
})

describe("isSingleFileBunTestArgs", () => {
  test("accepts exactly one test file", () => {
    expect(isSingleFileBunTestArgs(" src/foo.test.ts --reporter=dots")).toBe(true)
  })

  test("rejects multiple test files and directory runs", () => {
    expect(isSingleFileBunTestArgs(" src/foo.test.ts src/bar.test.ts")).toBe(false)
    expect(isSingleFileBunTestArgs(" src/")).toBe(false)
  })
})

describe("findNonCanonicalGitInvocation", () => {
  test("accepts canonical Git commands at shell segment boundaries", () => {
    expect(
      findNonCanonicalGitInvocation(
        "git status && git -C /tmp/repo -c color.ui=false log --oneline"
      )
    ).toBeNull()
  })

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

  test("classifies direct Git binary paths", () => {
    expect(findNonCanonicalGitInvocation("/usr/bin/git status")?.kind).toBe("binary-path")
    expect(findNonCanonicalGitInvocation("./git status")?.kind).toBe("binary-path")
  })

  test("classifies command and environment wrappers", () => {
    expect(findNonCanonicalGitInvocation("env git status")?.kind).toBe("command-wrapper")
    expect(findNonCanonicalGitInvocation("GIT_OPTIONAL_LOCKS=0 git status")?.kind).toBe(
      "command-wrapper"
    )
    expect(findNonCanonicalGitInvocation("printf x | xargs git status")?.kind).toBe(
      "command-wrapper"
    )
    expect(findNonCanonicalGitInvocation("if git status; then echo ready; fi")?.kind).toBe(
      "command-wrapper"
    )
    expect(findNonCanonicalGitInvocation("(git status)")?.kind).toBe("command-wrapper")
  })

  test("classifies nested shell invocations recursively", () => {
    expect(findNonCanonicalGitInvocation("/bin/zsh -lc 'git status'")?.kind).toBe("nested-shell")
    expect(findNonCanonicalGitInvocation("zsh -lc 'bash -c \"git status\"'")?.kind).toBe(
      "nested-shell"
    )
    expect(findNonCanonicalGitInvocation("/usr/bin/env zsh -lc 'git status'")?.kind).toBe(
      "nested-shell"
    )
    expect(findNonCanonicalGitInvocation("sudo sh -c 'git status'")?.kind).toBe("nested-shell")
  })

  test("classifies command and process substitutions with mutating Git", () => {
    expect(findNonCanonicalGitInvocation('echo "$(git push origin main)"')?.kind).toBe(
      "shell-substitution"
    )
    expect(findNonCanonicalGitInvocation("diff <(git reset --hard HEAD) expected")?.kind).toBe(
      "shell-substitution"
    )
    expect(findNonCanonicalGitInvocation("echo `git commit -m x`")?.kind).toBe("shell-substitution")
  })

  test("classifies substitutions whose bodies use wrappers or config writes", () => {
    expect(findNonCanonicalGitInvocation("V=$(env git status)")?.kind).toBe("shell-substitution")
    expect(findNonCanonicalGitInvocation("V=$(/usr/bin/git status)")?.kind).toBe(
      "shell-substitution"
    )
    expect(findNonCanonicalGitInvocation('V=$(git config user.name "X Y")')?.kind).toBe(
      "shell-substitution"
    )
    expect(
      findNonCanonicalGitInvocation("V=$(git config --global --unset core.hooksPath)")?.kind
    ).toBe("shell-substitution")
  })

  test("allows read-only Git inside command substitution", () => {
    expect(findNonCanonicalGitInvocation('echo "$(git status)"')).toBeNull()
    expect(
      findNonCanonicalGitInvocation("STATUS=$(git status --short --branch | head -1)")
    ).toBeNull()
    expect(
      findNonCanonicalGitInvocation(
        'HOOKS_PATH=$(git config --path --get core.hooksPath 2>/dev/null || git rev-parse --git-path hooks 2>/dev/null || echo "")'
      )
    ).toBeNull()
    expect(findNonCanonicalGitInvocation("GIT_NAME=$(git config user.name)")).toBeNull()
    expect(
      findNonCanonicalGitInvocation(
        'echo "SHA: $(git rev-parse HEAD) | Branch: $(git branch --show-current)"'
      )
    ).toBeNull()
  })

  test("ignores Git text that is not executed", () => {
    expect(findNonCanonicalGitInvocation("echo '/usr/bin/git status'")).toBeNull()
    expect(findNonCanonicalGitInvocation("rg 'git status' docs/")).toBeNull()
    expect(findNonCanonicalGitInvocation(`/bin/zsh -lc 'echo "git status"'`)).toBeNull()
    expect(findNonCanonicalGitInvocation("echo '`git status`'")).toBeNull()
  })
})
