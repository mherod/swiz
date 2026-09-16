import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  parseAntigravityJsonlEntries,
  parseTranscriptEntries,
} from "./transcript-analysis-parse-part2.ts"
import { parseTranscriptArgs } from "./transcript-args.ts"
import type { Session } from "./transcript-schemas.ts"
import { findAntigravitySessions } from "./transcript-sessions-discovery.ts"
import { loadSessionContent } from "./transcript-turns.ts"

function createToolTranscript(): string {
  return [
    JSON.stringify({
      step_index: 0,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      created_at: "2026-08-01T21:00:00Z",
      content: "<USER_REQUEST>Inspect this file</USER_REQUEST>",
    }),
    JSON.stringify({
      step_index: 1,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      created_at: "2026-08-01T21:00:01Z",
      content: "I will inspect it.",
      tool_calls: [{ name: "read_file", args: '{"path":"src/index.ts"}' }],
    }),
    JSON.stringify({
      step_index: 2,
      source: "MODEL",
      type: "TOOL_RESPONSE",
      created_at: "2026-08-01T21:00:02Z",
      content: "export const ready = true",
    }),
  ].join("\n")
}

describe("Antigravity project discovery", () => {
  test.each([
    "antigravity",
    "antigravity-cli",
  ])("requires matching project hints for %s sessions", async (provider) => {
    const home = await mkdtemp(join(tmpdir(), "swiz-antigravity-project-"))
    try {
      const project = join(home, "workspace", "target")
      const root = join(home, ".gemini", provider)
      for (const id of ["missing", "empty", "unrelated", "matched"]) {
        const brain = join(root, "brain", id)
        if (provider === "antigravity-cli") {
          const logs = join(brain, ".system_generated", "logs")
          await mkdir(logs, { recursive: true })
          await Bun.write(join(logs, "transcript.jsonl"), createToolTranscript())
        } else {
          await mkdir(join(root, "conversations"), { recursive: true })
          await Bun.write(join(root, "conversations", `${id}.pb`), new Uint8Array([0]))
        }
        if (id === "missing") continue
        await mkdir(brain, { recursive: true })
        if (id === "empty") continue
        const hint = id === "matched" ? project : `${project}-other`
        await Bun.write(join(brain, "task.md"), `Working in file://${hint}/src/index.ts`)
      }

      expect((await findAntigravitySessions(project, home)).map((s) => s.id)).toEqual(["matched"])
      expect(await findAntigravitySessions(join(home, "unrelated-project"), home)).toEqual([])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe("parseAntigravityJsonlEntries", () => {
  test("parses user, assistant, tool-use, and tool-result records", () => {
    const transcript = createToolTranscript()

    expect(parseAntigravityJsonlEntries(transcript)).toEqual([
      {
        type: "user",
        timestamp: "2026-08-01T21:00:00Z",
        message: { role: "user", content: "Inspect this file" },
      },
      {
        type: "assistant",
        timestamp: "2026-08-01T21:00:01Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I will inspect it." },
            {
              type: "tool_use",
              id: "call_1_1",
              name: "read_file",
              input: { path: "src/index.ts" },
            },
          ],
        },
      },
      {
        type: "user",
        timestamp: "2026-08-01T21:00:02Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1_1",
              content: "export const ready = true",
            },
          ],
        },
      },
    ])
  })

  test("ignores malformed and unsupported records", () => {
    const transcript = [
      "not-json",
      JSON.stringify({ source: "MODEL", type: "PLANNER_RESPONSE", content: "" }),
      JSON.stringify({ source: "SYSTEM", type: "STATUS", content: "working" }),
    ].join("\n")

    expect(parseAntigravityJsonlEntries(transcript)).toEqual([])
  })

  test("auto-detects Antigravity records for generic transcript readers", () => {
    const transcript = createToolTranscript()
    expect(parseTranscriptEntries(transcript)).toEqual(parseAntigravityJsonlEntries(transcript))
  })

  test("preserves tool state when loading head-limited transcript turns", async () => {
    const directory = await mkdtemp(join(tmpdir(), "swiz-antigravity-turns-"))
    try {
      const transcriptPath = join(directory, "transcript.jsonl")
      await Bun.write(transcriptPath, `${createToolTranscript()}\n`)
      const session: Session = {
        id: "antigravity-streaming-test",
        path: transcriptPath,
        mtime: Date.now(),
        provider: "antigravity",
        format: "antigravity-jsonl",
      }
      const parsed = { ...parseTranscriptArgs([]), headCount: 3 }

      const { turns } = await loadSessionContent(session, parsed, {}, false)

      expect(turns).toHaveLength(3)
      expect(turns[2]?.entry.message?.content).toEqual([
        {
          type: "tool_result",
          tool_use_id: "call_1_1",
          content: "export const ready = true",
        },
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
