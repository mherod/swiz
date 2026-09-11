import { getGitClient } from "../git/client.ts"
import type { ParsedGitInvocationTokens } from "./shell-patterns.ts"

/** Resolve the repository Git will actually use, including repeated -C and --git-dir. */
export async function resolveGitRepository(
  invocation: ParsedGitInvocationTokens,
  cwd: string
): Promise<string | null> {
  const result = await getGitClient().run(
    [...invocation.globalArgs, "rev-parse", "--show-toplevel"],
    { cwd }
  )
  return result.exitCode === 0 ? result.stdout.trim() || null : null
}

export async function gitCheckoutRefExists(
  invocation: ParsedGitInvocationTokens,
  cwd: string,
  ref: string
): Promise<boolean> {
  const result = await getGitClient().run(
    [...invocation.globalArgs, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
    { cwd }
  )
  return result.exitCode === 0 && result.stdout.trim().length > 0
}

interface TrunkGitRuntime {
  resolveRepository: typeof resolveGitRepository
  isGitRepo(cwd: string): Promise<boolean>
  readProjectSettings(cwd: string): Promise<{ trunkMode?: boolean } | null>
}

/** Share target-repository policy across branch and worktree gates. */
export async function resolveTrunkGitRepository(
  invocation: ParsedGitInvocationTokens,
  sourceCwd: string,
  runtime: TrunkGitRuntime
): Promise<string | null> {
  const cwd = await runtime.resolveRepository(invocation, sourceCwd)
  if (!cwd || !(await runtime.isGitRepo(cwd))) return null
  return (await runtime.readProjectSettings(cwd))?.trunkMode ? cwd : null
}

const SAFE_WORKTREE_OPTIONS = new Set([
  "--detach",
  "--checkout",
  "--no-checkout",
  "--lock",
  "--quiet",
  "--no-guess-remote",
])

function isSafeWorktreeOption(arg: string): boolean {
  return SAFE_WORKTREE_OPTIONS.has(arg) || /^-[dq]+$/.test(arg) || arg.startsWith("--reason=")
}

/** Only explicitly named refs are eligible; unknown options cannot grant an exception. */
export function worktreeCheckoutRef(args: string[]): string | null {
  const positionals: string[] = []
  let optionsEnded = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (optionsEnded || !arg.startsWith("-")) {
      positionals.push(arg)
    } else if (arg === "--") {
      optionsEnded = true
    } else if (arg === "--reason") {
      if (args[++index] === undefined) return null
    } else if (!isSafeWorktreeOption(arg)) {
      // Includes -b/-B, --orphan, --track, --guess-remote and --force.
      return null
    }
  }
  return positionals.length === 2 ? positionals[1] || null : null
}

function checkoutArguments(invocation: ParsedGitInvocationTokens) {
  const separator = invocation.args.indexOf("--")
  const args = separator < 0 ? invocation.args : invocation.args.slice(0, separator)
  const targets = args.filter((arg) => !arg.startsWith("-"))
  if (separator >= 0) targets.push(...invocation.args.slice(separator + 1))
  return { args, targets, hasPathspec: separator >= 0 && invocation.subcommand === "checkout" }
}

function canGuessCheckoutBranch(args: string[]): boolean {
  if (args.some((arg) => arg === "--detach" || /^-[dq]*d[dq]*$/.test(arg))) return false
  return args.lastIndexOf("--no-guess") <= args.lastIndexOf("--guess")
}

/** Detect tracking-branch materialization even when checkout/switch omits -b/-c. */
export async function checkoutCreatesImplicitBranch(
  invocation: ParsedGitInvocationTokens,
  cwd: string
): Promise<boolean> {
  if (!["switch", "checkout"].includes(invocation.subcommand)) return false
  const { args, targets, hasPathspec } = checkoutArguments(invocation)
  if (args.some((arg) => /^--track(?:=|$)|^-[^-]*t/.test(arg))) return true
  if (hasPathspec || targets.length !== 1 || !canGuessCheckoutBranch(args)) return false
  const target = targets[0]!
  if (await gitCheckoutRefExists(invocation, cwd, target)) return false
  const refs = await getGitClient().run(
    [...invocation.globalArgs, "for-each-ref", "--format=%(refname)", "refs/remotes/"],
    { cwd }
  )
  return (
    refs.exitCode === 0 &&
    refs.stdout.split("\n").some((ref) => {
      const branch = ref.replace(/^refs\/remotes\/[^/]+\//, "")
      return branch === target
    })
  )
}
