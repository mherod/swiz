/**
 * Reading a file must not require a task first.
 *
 * Reading is how an agent decides what to plan. Gating it behind "you already have a task"
 * inverts the order and produces plans written before the code is read — one of the mechanisms
 * that fills the task store with rows nobody needed. `grep`/`rg`/`ls` were already exempt while
 * `cat`/`sed -n`/`head`/`tail` were not, which made the split arbitrary rather than principled.
 *
 * The exemption stops at anything that can write, so `cat > file` stays gated.
 */

import { describe, expect, test } from "bun:test"
import { isTaskTrackingExemptShellCommand } from "./git-utils.ts"

const READ_ONLY = [
  "cat src/foo.ts",
  "head -20 src/foo.ts",
  "tail -n 50 src/foo.ts",
  'sed -n "1,40p" src/foo.ts',
  "cat src/a.ts src/b.ts",
  "head -5 pkg.json && tail -5 pkg.json",
]

/** Already exempt before this change — proves the existing behaviour is untouched. */
const ALREADY_EXEMPT = ["ls src", "rg -n needle src", "grep -rn needle src", "git status"]

/**
 * `bun run build` and friends are deliberately exempt already (SETUP_CMD_RE covers setup,
 * install, lint, build, format, test and typecheck), so they do not belong here — this list is
 * only for commands that must not be exempted *by the inspection rule*.
 */
const MUST_STAY_GATED = [
  "cat template > src/out.ts",
  "cat template >> src/out.ts",
  'sed -i "" "s/a/b/" src/foo.ts',
  "head -5 in.txt > out.txt",
  "cat data | tee dest.txt",
  "rm -rf dist",
]

describe("read-only inspection is exempt from task tracking", () => {
  test.each(READ_ONLY)("%s does not require an open task", (command) => {
    expect(isTaskTrackingExemptShellCommand(command)).toBe(true)
  })

  test.each(ALREADY_EXEMPT)("%s stays exempt", (command) => {
    expect(isTaskTrackingExemptShellCommand(command)).toBe(true)
  })
})

describe("anything that can write stays gated", () => {
  test.each(MUST_STAY_GATED)("%s still requires a task", (command) => {
    // The control for the block above: the exemption must key on read-only-ness, not on the
    // command name. `cat > file` reads like a read and is not one.
    expect(isTaskTrackingExemptShellCommand(command)).toBe(false)
  })
})
