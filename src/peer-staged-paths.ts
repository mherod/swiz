/**
 * Paths a deletion must not touch because someone deliberately staged them.
 *
 * Every wildcard rule in the collaboration guidance — no `git add -A`, no `git clean`, no
 * `rm -rf` — is aimed at commands whose blast radius is wide. The deletion that actually
 * destroyed a peer's work in this fleet was the opposite shape: `trash app/favicon.ico` followed
 * by `git rm --cached app/favicon.ico`. Two commands, one path each, precisely scoped, and
 * `trash` is the very command the banned-commands hook recommends as the safe alternative to
 * `rm`. Narrow scoping is not the safety property; ownership is.
 *
 * The evidence that would have prevented it was already on screen. `git status --short` reported
 * `AD` for the path: `A` means staged as a new file, which is a deliberate act by whoever staged
 * it, and the direct negation of "build residue". Every other signal the deleting session used —
 * an mtime matching its own build, an unexpected byte size, a `git log --all` history showing the
 * path tracked and later deleted — was individually true and collectively wrong. History
 * describes the *name*; it says nothing about the bytes someone added five minutes ago.
 *
 * So this checks the one signal that settles it, and only that one.
 */

import { gitAttempt } from "./git-helpers.ts"

/** Status codes in the index that mean "someone put this here on purpose". */
const DELIBERATE_INDEX_CODES = new Set(["A", "M", "R", "C"])

export interface StagedPathFinding {
  /** Path as it appeared in the command. */
  path: string
  /** Two-letter porcelain status, e.g. `AD`, `A `, `M `. */
  status: string
}

/**
 * Whether a porcelain status line means the path was deliberately staged.
 *
 * Only the index column (the first character) counts. `AD` is the interesting case: staged as
 * added, then deleted from the working tree — which is precisely the state a session leaves
 * behind when it trashes a peer's newly staged file, and the state that should have stopped it.
 */
export function isDeliberatelyStaged(status: string): boolean {
  const indexCode = status.charAt(0)
  return DELIBERATE_INDEX_CODES.has(indexCode)
}

/**
 * Ask Git for the status of one path.
 *
 * Returns null when Git cannot answer — outside a repository, an unreadable path, a failed
 * invocation. An unanswerable check is not evidence of ownership and must not block.
 */
export async function readPathStatus(path: string, cwd: string): Promise<string | null> {
  const result = await gitAttempt(["--no-optional-locks", "status", "--porcelain", "--", path], cwd)
  // `ran` alone is not enough: it stays true for exit 1, which `status` never uses for success.
  if (!result.ran || result.exitCode !== 0) return null
  const line = result.stdout.split("\n").find((entry) => entry.trim().length > 0)
  return line ? line.slice(0, 2) : null
}

/**
 * Untracked paths, which are the *less* recoverable case.
 *
 * A staged file survives its own deletion: the blob is already in the object store, so
 * `git checkout-index` or the reflog can bring it back. An untracked file has no git object
 * anywhere — trashing it is final. So the staged check above protects the recoverable case, and
 * this one exists because the unrecoverable case must not be the permissive default.
 *
 * Untracked alone cannot justify a block: a session's own scratch files are untracked too, and a
 * blanket deny would make ordinary cleanup impossible. The caller pairs this with edit-ownership
 * evidence and blocks only what another session is known to have created.
 */
export async function findUntrackedPaths(paths: readonly string[], cwd: string): Promise<string[]> {
  const untracked: string[] = []
  for (const path of paths) {
    const status = await readPathStatus(path, cwd)
    if (status === "??") untracked.push(path)
  }
  return untracked
}

/** Every path in the list that Git reports as deliberately staged. */
export async function findStagedPaths(
  paths: readonly string[],
  cwd: string
): Promise<StagedPathFinding[]> {
  const findings: StagedPathFinding[] = []
  for (const path of paths) {
    const status = await readPathStatus(path, cwd)
    if (status && isDeliberatelyStaged(status)) findings.push({ path, status })
  }
  return findings
}

/** Split a command into tokens, unwrapping single and double quotes. */
function tokenize(command: string): string[] {
  const tokens: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match = pattern.exec(command)
  while (match) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "")
    match = pattern.exec(command)
  }
  return tokens
}

/** Operands after a subcommand: flags dropped, `--` separator dropped, values kept. */
function operandsAfter(tokens: readonly string[], startIndex: number): string[] {
  const operands: string[] = []
  for (let i = startIndex; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token || token === "--") continue
    if (token.startsWith("-")) continue
    operands.push(token)
  }
  return operands
}

/** Index of the git subcommand, skipping global options and the values they consume. */
function gitSubcommandIndex(tokens: readonly string[]): number {
  const valueTaking = new Set(["-C", "--git-dir", "--work-tree"])
  let i = 1
  while (i < tokens.length) {
    const token = tokens[i] ?? ""
    if (valueTaking.has(token)) {
      i += 2
      continue
    }
    if (!token.startsWith("-")) break
    i += 1
  }
  return i
}

/**
 * Paths a single command would delete or unstage.
 *
 * Covers `trash` and `git rm` (including `--cached`). `rm`, `git clean`, `git restore`, and
 * `git checkout -- <path>` are already refused outright elsewhere, so they never reach a
 * provenance question.
 */
export function extractDeletionTargets(command: string): string[] {
  const segments = command.split(/(?:&&|\|\||;|\|)/)
  const targets: string[] = []

  for (const segment of segments) {
    const tokens = tokenize(segment.trim())
    if (tokens.length === 0) continue

    if (tokens[0] === "trash") {
      targets.push(...operandsAfter(tokens, 1))
      continue
    }

    if (tokens[0] !== "git") continue
    const subcommand = gitSubcommandIndex(tokens)
    if (tokens[subcommand] === "rm") targets.push(...operandsAfter(tokens, subcommand + 1))
  }

  return targets
}

/** The refusal text for a deletion that would destroy deliberately staged work. */
export function formatStagedPathDenial(findings: readonly StagedPathFinding[]): string {
  const lines = findings.map((finding) => `  - ${finding.path} — git status: \`${finding.status}\``)
  const subject = findings.length === 1 ? "This path is" : "These paths are"

  return [
    `BLOCKED: ${subject} staged in the index — someone put it there on purpose.`,
    ...lines,
    "",
    "This does not say the path is not yours; it says whose it is has not been established.",
    "A leading `A` means staged as a new file, which is the direct negation of build residue,",
    "and in a shared checkout the session that staged it may be another one, mid-work.",
    "",
    "Being single-path is not evidence of safety: `trash <path>` and `git rm --cached <path>` are",
    "as narrowly scoped as anything and still destroy the file completely.",
    "",
    "Before deleting, establish provenance in this order:",
    "  1. `git status --short -- <path>` — `A`/`AD` settles that it was staged; stop here.",
    "  2. Does the build actually emit this path? For generated-vs-source specifically, an mtime",
    "     matching your last build is consistent with a source file someone just added.",
    "  3. Ask the peer. Authoritative, and cheaper than every inference above.",
    "",
    "If it is yours and genuinely disposable, unstage it first (`git restore --staged <path>`)",
    "so the index no longer claims otherwise, then delete.",
  ].join("\n")
}

/**
 * The refusal text for deleting an untracked file another session created.
 *
 * Kept separate from the staged denial because the stakes differ: this deletion cannot be undone
 * from git at all, and the reader needs to know that before deciding to argue with the block.
 */
export function formatPeerCreatedDenial(paths: readonly string[]): string {
  const subject = paths.length === 1 ? "This path is" : "These paths are"

  return [
    `BLOCKED: ${subject} untracked and another live session created or edited it.`,
    ...paths.map((path) => `  - ${path}`),
    "",
    "Untracked deletion is unrecoverable. A staged file survives being trashed because its blob",
    "is already in the object store; an untracked file has no git object anywhere, so there is no",
    "`git checkout-index` and no reflog entry to recover from. This is the irreversible case.",
    "",
    "The peer may be mid-work on a file it has not staged yet. Ask before removing it, or leave it",
    "and say so — an unfamiliar file in a shared checkout is not evidence that it is disposable.",
  ].join("\n")
}
