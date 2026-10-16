import { expect, test } from "bun:test"
import { join } from "node:path"
import { useTempDir } from "./utils/test-utils.ts"

const tmp = useTempDir("swiz-command-defaults-")

test("commands pass their preferences and retain 15-second budgets", async () => {
  const cwd = await tmp.create()
  const providerPath = join(import.meta.dir, "ai-providers.ts")
  const proc = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
    import { mock } from "bun:test";
    const actual = await import(${JSON.stringify(providerPath)});
    const captured = {};
    mock.module(${JSON.stringify(providerPath)}, () => ({...actual,
      hasAiProvider: () => true,
      promptObject: async (_prompt, _schema, options) => { captured.idea = options; throw new Error("captured"); },
      withProviderModel: async (_operation, options) => { captured.reply = options; throw new Error("captured"); },
      promptText: async (_prompt, options) => { captured.steering = options; return "Please run the tests, thanks."; }
    }));
    const signals = await import(${JSON.stringify(join(import.meta.dir, "ai-signal.ts"))});
    const resolveSignal = signals.resolveSignal;
    mock.module(${JSON.stringify(join(import.meta.dir, "ai-signal.ts"))}, () => ({...signals,
      resolveSignal: options => { captured.steeringTimeout = options.timeout; return resolveSignal(options); }
    }));
    const { ideaCommand } = await import(${JSON.stringify(join(import.meta.dir, "commands/idea.ts"))});
    const { streamAutoReply } = await import(${JSON.stringify(join(import.meta.dir, "commands/transcript.ts"))});
    const { humaniseAutoSteerMessage } = await import(${JSON.stringify(join(import.meta.dir, "utils/auto-steer-helpers.ts"))});
    try { await ideaCommand.run(["--dir", process.cwd(), "--json"]); } catch {}
    try { await streamAutoReply([], {sessionId:"test",flipRoles:false,cwd:process.cwd(),passNumber:1}); } catch {}
    await humaniseAutoSteerMessage("Run the tests.");
    console.log(JSON.stringify(captured));
  `,
    ],
    {
      cwd,
      env: { HOME: cwd, PATH: "", AI_TEST_NO_BACKEND: "1", SWIZ_PROMPT_CACHE_DIR: cwd },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    }
  )
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  expect(stderr).toBe("")
  expect(proc.exitCode).toBe(0)
  const result = JSON.parse(stdout)
  expect(result.idea).toMatchObject({ preferredProvider: "agy", timeout: 15_000 })
  expect(result.reply).toMatchObject({ preferredProvider: "codex", timeout: 15_000 })
  expect(result.steering).toMatchObject({ preferredProvider: "claude" })
  expect(result.steeringTimeout).toBe(15_000)
  expect(result.idea.provider).toBeUndefined()
  expect(result.reply.provider).toBeUndefined()
  expect(result.steering.provider).toBeUndefined()
})
