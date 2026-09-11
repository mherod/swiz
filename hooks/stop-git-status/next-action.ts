import { type StopAction, stopActionId } from "../../src/stop-actions.ts"
import type { GitContext } from "./types.ts"

function isCleanPush(ctx: GitContext): boolean {
  const { ahead, behind, upstreamGone, upstream } = ctx.gitStatus
  return (
    !ctx.hasUncommitted && ctx.hasRemote && behind === 0 && ahead > 0 && !upstreamGone && !!upstream
  )
}

function needsRecovery(ctx: GitContext): boolean {
  const { branch } = ctx.gitStatus
  return (
    branch === "(detached)" ||
    (ctx.trunkMode && (!!ctx.strictNoDirectMain || branch !== ctx.defaultBranch))
  )
}

function hasCertainOwnership(ctx: GitContext): boolean {
  return ctx.ownership.known && ctx.ownership.ownership.editedByOthers.length === 0
}

/** Only compact a fully resolved push; ownership/recovery constraints keep their full diagnosis. */
export function buildGitStopAction(ctx: GitContext): StopAction | undefined {
  if (!isCleanPush(ctx) || needsRecovery(ctx) || !hasCertainOwnership(ctx)) return undefined
  const { branch, ahead } = ctx.gitStatus
  const policy =
    ctx.trunkMode && branch === ctx.defaultBranch
      ? `Use the configured trunk workflow on ${branch}.`
      : ctx.strictNoDirectMain
        ? `Use a feature branch and PR; direct pushes to ${ctx.defaultBranch} are prohibited.`
        : "Follow the configured collaboration and branch policy."
  return {
    id: stopActionId(ctx.cwd, "push", ctx.upstream),
    kind: "push",
    title: `Publish ${ahead} local commit${ahead === 1 ? "" : "s"}`,
    reason: `${branch} is ${ahead} commit${ahead === 1 ? "" : "s"} ahead of ${ctx.upstream}; the working tree is clean.`,
    instruction: `Run /push. ${policy}`,
    doneWhen: "Remote parity is confirmed and the CI outcome is recorded.",
  }
}
