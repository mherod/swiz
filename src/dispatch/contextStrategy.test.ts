import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { getAgent } from "../agents.ts"
import type { HookDef } from "../hook-types.ts"
import { hookOutputSchema } from "../schemas.ts"
import { useTempDir } from "../utils/test-utils.ts"
import { ContextStrategy } from "./contextStrategy.ts"
import { stripInternalDispatchFields } from "./dispatch-wire.ts"
import * as engine from "./engine.ts"
import { DISPATCH_ROUTES } from "./index.ts"

const temp = useTempDir("swiz-context-strategy-")
const write = spyOn(engine, "writeResponse").mockImplementation(() => {})
let cwd: string
beforeEach(async () => {
  cwd = await temp.create()
  write.mockClear()
})
afterAll(() => mock.restore())

function fixture(output: Record<string, unknown>, index = 0): HookDef {
  return { hook: { name: `context-fixture-${index}`, event: "sessionStart", run: () => output } }
}

async function execute(
  canonicalEvent: string,
  hooks: HookDef[],
  agentId = "claude",
  signal?: AbortSignal
) {
  const hookEventName = getAgent("claude")!.eventMap[canonicalEvent]!
  const result = await new ContextStrategy().execute({
    canonicalEvent,
    hookEventName,
    agentId,
    cwd,
    signal,
    daemonContext: true,
    enrichedPayloadStr: JSON.stringify({ cwd, _effectiveSettings: { humaniseAutoSteer: false } }),
    filteredGroups: [{ event: canonicalEvent, hooks }],
  })
  const wire = hookOutputSchema.parse(stripInternalDispatchFields(result))
  expect(write).toHaveBeenCalledWith(result)
  return { result, wire }
}

const contextRoutes = Object.entries(DISPATCH_ROUTES).filter(
  ([, strategy]) => strategy === "context"
)

/** Local strategy-to-sanitizer fixtures; external acceptance is only confirmed for the reported events. */
describe("context route envelopes", () => {
  for (const [event] of contextRoutes) {
    test(`${event} preserves distinct merged text once`, async () => {
      const { wire } = await execute(event, [
        fixture({
          systemMessage: "Directive",
          hookSpecificOutput: { additionalContext: "Detail" },
        }),
        fixture(
          { systemMessage: "Shared", hookSpecificOutput: { additionalContext: "Shared" } },
          1
        ),
        fixture({ systemMessage: "Directive" }, 2),
      ])
      const expected = "Directive\n\nDetail\n\nShared"
      expect(wire.systemMessage).toBe(expected)
      if (event === "preCompact" || event === "postCompact") {
        expect(wire.hookSpecificOutput).toBeUndefined()
      } else {
        expect(wire.hookSpecificOutput).toEqual({
          hookEventName: getAgent("claude")!.eventMap[event],
          additionalContext: expected,
        })
      }
    })
  }

  test("system-message-only hooks retain their text", async () => {
    const { wire } = await execute("postCompact", [fixture({ systemMessage: "Recovery guidance" })])
    expect(wire).toEqual({ systemMessage: "Recovery guidance" })
  })

  test("does not discard a distinct message that is a substring of another", async () => {
    const { wire } = await execute("sessionStart", [
      fixture({
        systemMessage: "Status",
        hookSpecificOutput: { additionalContext: "Status detail" },
      }),
    ])
    expect(wire.systemMessage).toBe("Status\n\nStatus detail")
  })

  test("trims boundary whitespace before deduplicating identical fields", async () => {
    const { wire } = await execute("postCompact", [
      fixture({
        systemMessage: "  Guidance\n",
        hookSpecificOutput: { additionalContext: "Guidance" },
      }),
    ])
    expect(wire.systemMessage).toBe("Guidance")
  })

  for (const agent of ["codex", "cursor", "gemini"]) {
    test(`${agent} retains its existing sanitizer behavior`, async () => {
      const { wire } = await execute(
        "sessionStart",
        [
          fixture({
            systemMessage: "First.",
            hookSpecificOutput: { additionalContext: "Second." },
          }),
        ],
        agent
      )
      expect(wire.systemMessage).toBe(agent === "codex" ? "First. Second." : "First.\n\nSecond.")
      expect(wire.hookSpecificOutput?.additionalContext).toBe(
        agent === "codex" ? undefined : "First.\n\nSecond."
      )
    })
  }

  test("empty and whitespace-only results remain silent", async () => {
    const { wire } = await execute("sessionStart", [
      fixture({}),
      fixture({ systemMessage: " \n ", hookSpecificOutput: { additionalContext: "\t" } }, 1),
    ])
    expect(wire).toEqual({})
  })

  test("a skipped hook is recorded without executing or emitting context", async () => {
    const run = mock(() => ({ systemMessage: "Do not emit" }))
    const { result, wire } = await execute("sessionStart", [
      {
        hook: {
          name: "skip-context",
          event: "sessionStart",
          condition: `env:SWIZ_CONTEXT_${crypto.randomUUID()}`,
          run,
        },
      },
    ])
    expect(run).not.toHaveBeenCalled()
    expect(result.hookExecutions[0].status).toBe("skipped")
    expect(wire).toEqual({})
  })

  test("dispatch cancellation discards hooks that have not begun running", async () => {
    const controller = new AbortController()
    const run = mock(() => ({ systemMessage: "Do not emit" }))
    const pending = execute(
      "sessionStart",
      [
        {
          hook: {
            name: "aborted-context",
            event: "sessionStart",
            run,
          },
        },
      ],
      "claude",
      controller.signal
    )
    controller.abort()
    const { result, wire } = await pending
    expect(run).not.toHaveBeenCalled()
    expect(result.hookExecutions[0].status).toBe("aborted")
    expect(wire).toEqual({})
  })
})
