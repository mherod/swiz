import { z } from "zod"
import type { ActionPlanItem } from "./action-plan.ts"
import type { SwizHookOutput } from "./SwizHook.ts"

/** Internal hook-to-dispatch data. Never sent in the final agent envelope. */
export const stopActionSchema = z.object({
  id: z.string().min(1),
  kind: z.enum([
    "recovery",
    "commit",
    "sync",
    "verify",
    "push",
    "task",
    "handoff",
    "issue",
    "continuation",
  ]),
  title: z.string().min(1),
  reason: z.string().min(1),
  instruction: z.string().min(1),
  doneWhen: z.string().min(1),
})

export type StopAction = z.infer<typeof stopActionSchema>

const ORDER: Record<StopAction["kind"], number> = {
  recovery: 10,
  commit: 20,
  sync: 30,
  verify: 40,
  push: 50,
  task: 60,
  handoff: 70,
  issue: 80,
  continuation: 90,
}

export function stopActionPriority(action?: StopAction): number {
  return action ? ORDER[action.kind] : 0
}

export interface StopFinding {
  file: string
  reason: string
  actions: StopAction[]
  humanRequired?: boolean
}

export function readStopActions(value: z.input<z.ZodUnknown>): StopAction[] {
  const parsed = z.array(stopActionSchema).min(1).safeParse(value)
  return parsed.success ? parsed.data : []
}

export function withStopAction(output: SwizHookOutput, action?: StopAction): SwizHookOutput {
  return action ? { ...output, _stopActions: [action] } : output
}

export function stopActionPlan(
  action: StopAction | undefined,
  fallback: ActionPlanItem[]
): ActionPlanItem[] {
  return action ? [action.title, [action.instruction, action.doneWhen]] : fallback
}

/** IDs include the repository and target, so distinct repositories never collapse. */
export function stopActionId(cwd: string, operation: string, target = ""): string {
  return JSON.stringify([cwd, operation, target])
}

export function renderStopAction(action: StopAction): string {
  return [
    `Next: ${action.title}`,
    "",
    action.reason,
    "",
    action.instruction,
    "",
    `Done when: ${action.doneWhen}`,
    "",
    "Reassess remaining findings after this action.",
  ].join("\n")
}

/** Unknown and human-required findings stay verbatim and take precedence over routine work. */
export function selectStopAction(findings: StopFinding[]): {
  reason: string
  humanRequired: boolean
} | null {
  const candidates = findings.flatMap((finding) => {
    if (finding.humanRequired || finding.actions.length === 0) {
      return [
        {
          id: `raw:${finding.reason.trim()}`,
          priority: finding.humanRequired ? -1 : 0,
          reason: finding.reason,
          humanRequired: finding.humanRequired ?? false,
        },
      ]
    }
    return finding.actions.map((action) => ({
      id: action.id,
      priority: ORDER[action.kind],
      reason: renderStopAction(action),
      humanRequired: false,
    }))
  })
  const unique = new Map<string, (typeof candidates)[number]>()
  for (const candidate of candidates) {
    const previous = unique.get(candidate.id)
    if (!previous || candidate.priority < previous.priority) unique.set(candidate.id, candidate)
  }
  const selected = [...unique.values()].sort(
    (a, b) => a.priority - b.priority || a.id.localeCompare(b.id)
  )[0]
  return selected ? { reason: selected.reason, humanRequired: selected.humanRequired } : null
}
