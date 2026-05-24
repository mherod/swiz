#!/usr/bin/env bun

import { git } from "../src/git-helpers.ts"
import {
  buildContextHookOutput,
  runSwizHookAsMain,
  type SwizHook,
  type SwizHookOutput,
} from "../src/SwizHook.ts"
import { userPromptSubmitHookInputSchema } from "../src/schemas.ts"
import { buildBehaviorSteeringContext } from "../src/settings/behavior-context.ts"
import { buildGitContextLine, DETACHED_HEAD_WARNING } from "../src/utils/git-context-messages.ts"

async function resolveBehaviorContext(
  cwd: string,
  sessionId?: string
): Promise<{
  context: string
  gitOptions: {
    collaborationMode?: string
    trunkMode?: boolean
    strictNoDirectMain?: boolean
    defaultBranch?: string
  }
}> {
  try {
    const { getEffectiveSwizSettings, readProjectSettings, readSwizSettings } = await import(
      "../src/settings.ts"
    )
    const [settings, projectSettings] = await Promise.all([
      readSwizSettings(),
      readProjectSettings(cwd),
    ])
    const effective = getEffectiveSwizSettings(settings, sessionId, projectSettings)
    const defaultBranch = projectSettings?.defaultBranch
    return {
      context: buildBehaviorSteeringContext(effective, {
        defaultBranch,
        memoryLineThreshold: projectSettings?.memoryLineThreshold,
        memoryWordThreshold: projectSettings?.memoryWordThreshold,
      }),
      gitOptions: {
        collaborationMode: effective.collaborationMode,
        trunkMode: effective.trunkMode,
        strictNoDirectMain: effective.strictNoDirectMain,
        defaultBranch,
      },
    }
  } catch {
    return { context: "", gitOptions: {} }
  }
}

function combineContext(...parts: string[]): string {
  return parts.filter(Boolean).join("\n")
}

export async function evaluateUserpromptsubmitGitContext(input: unknown): Promise<SwizHookOutput> {
  const hookInput = userPromptSubmitHookInputSchema.parse(input)
  const cwd = hookInput.cwd ?? process.cwd()
  const behavior = await resolveBehaviorContext(cwd, hookInput.session_id)

  // Dynamic import to avoid circular dep (manifest → git-utils → settings → manifest)
  const { getGitStatusV2 } = await import("../src/utils/git-utils.ts")
  const gitStatus = await getGitStatusV2(cwd)

  if (!gitStatus) {
    const branch = (await git(["branch", "--show-current"], cwd)).trim() || "(unknown)"
    const line =
      branch === "(unknown)" ? `HEAD is detached. ${DETACHED_HEAD_WARNING}` : `On branch ${branch}.`
    return buildContextHookOutput("UserPromptSubmit", combineContext(line, behavior.context))
  }

  let gitLine = buildGitContextLine(gitStatus, behavior.gitOptions)
  if (gitStatus.total > 0 && gitStatus.lines && gitStatus.lines.length > 0) {
    const maxFiles = 30
    const editedByUs: string[] = []
    let editedByOthers: string[] = []

    if (hookInput.session_id) {
      try {
        const { getIssueStoreReader } = await import("../src/issue-store.ts")
        const { projectKeyFromCwd } = await import("../src/transcript-utils.ts")
        const { resolve, relative } = await import("node:path")

        const projectKey = projectKeyFromCwd(cwd)
        const store = getIssueStoreReader()
        const rawEdits = await store.listSessionEdits(projectKey, hookInput.session_id)

        let gitRoot = cwd
        try {
          gitRoot = (await git(["rev-parse", "--show-toplevel"], cwd)).trim()
        } catch {
          // fallback
        }

        const dbPaths = new Set(
          rawEdits.map((e: any) => {
            const abs = resolve(cwd, e.file_path)
            return relative(gitRoot, abs)
          })
        )

        for (const file of gitStatus.lines) {
          const normalizedFile = relative(gitRoot, resolve(gitRoot, file))
          if (dbPaths.has(normalizedFile)) {
            editedByUs.push(file)
          } else {
            editedByOthers.push(file)
          }
        }
      } catch {
        editedByOthers = gitStatus.lines
      }
    } else {
      editedByOthers = gitStatus.lines
    }

    gitLine += `\nUncommitted files:`
    if (editedByUs.length > 0) {
      const visibleUs = editedByUs.slice(0, maxFiles)
      gitLine +=
        `\n  Edited in this session (by us):\n` +
        visibleUs.map((file) => `    - ${file}`).join("\n")
      if (editedByUs.length > maxFiles) {
        gitLine += `\n    ... and ${editedByUs.length - maxFiles} more file(s)`
      }
    }
    if (editedByOthers.length > 0) {
      const remainingSlots = Math.max(5, maxFiles - editedByUs.length)
      const visibleOthers = editedByOthers.slice(0, remainingSlots)
      gitLine +=
        `\n  Edited externally (by tools or other parallel agents):\n` +
        visibleOthers.map((file) => `    - ${file}`).join("\n")
      if (editedByOthers.length > remainingSlots) {
        gitLine += `\n    ... and ${editedByOthers.length - remainingSlots} more file(s)`
      }
    }
  }

  return buildContextHookOutput("UserPromptSubmit", combineContext(gitLine, behavior.context))
}

const userpromptsubmitGitContext: SwizHook<Record<string, any>> = {
  name: "userpromptsubmit-git-context",
  event: "userPromptSubmit",
  timeout: 5,
  run(input) {
    return evaluateUserpromptsubmitGitContext(input)
  },
}

export default userpromptsubmitGitContext

if (import.meta.main) {
  await runSwizHookAsMain(userpromptsubmitGitContext)
}
