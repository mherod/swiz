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
