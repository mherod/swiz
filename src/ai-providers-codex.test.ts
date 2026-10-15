import { expect, test } from "bun:test"
import { chmodSync } from "node:fs"
import { join } from "node:path"
import { useTempDir } from "./utils/test-utils.ts"

const tmp = useTempDir("swiz-codex-provider-")
const providerPath = join(import.meta.dir, "ai-providers.ts")
const zodPath = Bun.resolveSync("zod", import.meta.dir)

async function fixture() {
  const cwd = await tmp.create()
  const executable = join(cwd, "bin", "codex")
  const capture = join(cwd, "capture.json")
  await Bun.write(
    executable,
    `#!${process.execPath}
const args = process.argv.slice(2)
const schemaIndex = args.indexOf("--output-schema")
const schema = schemaIndex >= 0 ? await Bun.file(args[schemaIndex + 1]).json() : null
const prompt = await Bun.stdin.text()
await Bun.write(process.env.CODEX_CAPTURE, JSON.stringify({args, schema, prompt}))
if (process.env.CODEX_STUB_MODE === "hang") await new Promise(() => setInterval(() => {}, 1000))
if (process.env.CODEX_STUB_MODE === "fail") {
  console.error("fixture authentication failed")
  process.exit(1)
}
const text = process.env.CODEX_STUB_RESPONSE ?? "  compatible  "
console.log(JSON.stringify({type: "thread.started", thread_id: "fixture-thread"}))
console.log(JSON.stringify({type: "item.completed", item: {id: "answer", type: "agent_message", text}}))
console.log(JSON.stringify({type: "turn.completed", usage: {input_tokens: 3, output_tokens: 2}}))
`
  )
  chmodSync(executable, 0o755)
  return { cwd, capture }
}

async function run(
  f: Awaited<ReturnType<typeof fixture>>,
  code: string,
  overrides: Record<string, string> = {}
) {
  // A separate process prevents PATH/env and provider module state leaking to
  // other suites. Its PATH contains only our stub, never a real AI backend.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(AI_|GEMINI_|OPENROUTER_|CODEX_MODEL$)/.test(key)
    )
  )
  const proc = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `import { activeProvider, hasAiProvider, promptText, promptStreamText, promptObject } from ${JSON.stringify(providerPath)};
       import { z } from ${JSON.stringify(zodPath)};
       ${code}`,
    ],
    {
      cwd: f.cwd,
      env: {
        ...env,
        HOME: f.cwd,
        PATH: join(f.cwd, "bin"),
        CODEX_CAPTURE: f.capture,
        ...overrides,
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 8_000,
    }
  )
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  expect(stderr).toBe("")
  expect(proc.exitCode).toBe(0)
  return JSON.parse(stdout)
}

test("Codex auto-selection generates text through the installed SDK adapter", async () => {
  const f = await fixture()
  expect(
    await run(
      f,
      `console.log(JSON.stringify({provider: activeProvider(), available: hasAiProvider(), text: await promptText("hello")}))`
    )
  ).toEqual({
    provider: "codex",
    available: true,
    text: "compatible",
  })
  const capture = await Bun.file(f.capture).json()
  expect(capture.prompt).toContain("hello")
  expect(capture.args).toContain("gpt-6-sol")
  expect(capture.args).toContain("sandbox_mode=read-only")
  expect(capture.args).toContain("approval_policy=never")
  expect(capture.args).not.toContain("--dangerously-bypass-approvals-and-sandbox")
})

test("explicit Codex selection streams text and overrides the environment model", async () => {
  const f = await fixture()
  expect(
    await run(
      f,
      `const parts = []; const text = await promptStreamText("hello", {provider: "codex", model: "custom-model", onTextPart: p => parts.push(p)}); console.log(JSON.stringify({text, parts}));`,
      {
        AI_PROVIDER: "openrouter",
        CODEX_MODEL: "environment-model",
      }
    )
  ).toEqual({ text: "compatible", parts: ["  compatible  "] })
  const { args } = await Bun.file(f.capture).json()
  expect(args[args.indexOf("-m") + 1]).toBe("custom-model")
})

test("Codex passes the object schema to the CLI and validates the response", async () => {
  const f = await fixture()
  expect(
    await run(
      f,
      `console.log(JSON.stringify(await promptObject("answer", z.object({answer: z.string()}))));`,
      {
        AI_PROVIDER: "codex",
        CODEX_MODEL: "environment-model",
        CODEX_STUB_RESPONSE: '{"answer":"compatible"}',
      }
    )
  ).toEqual({ answer: "compatible" })
  const { args, schema } = await Bun.file(f.capture).json()
  expect(args[args.indexOf("-m") + 1]).toBe("environment-model")
  expect(schema).toMatchObject({
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  })
})

test("Codex rejects an invalid structured response", async () => {
  const f = await fixture()
  const result = await run(
    f,
    `try { await promptObject("answer", z.object({answer: z.string()})); console.log(JSON.stringify({rejected: false})); } catch { console.log(JSON.stringify({rejected: true})); }`,
    {
      AI_PROVIDER: "codex",
      CODEX_STUB_RESPONSE: '{"answer":123}',
    }
  )
  expect(result).toEqual({ rejected: true })
})

test("Codex reports CLI failures without selecting another explicit provider", async () => {
  const f = await fixture()
  const result = await run(
    f,
    `let requests = 0; globalThis.fetch = async () => { requests++; throw new Error("unexpected fallback"); }; try { await promptText("hello", {provider: "codex"}); console.log(JSON.stringify({error: null})); } catch (error) { console.log(JSON.stringify({error: String(error), stderr: error.data?.stderr, requests})); }`,
    {
      CODEX_STUB_MODE: "fail",
      OPENROUTER_API_KEY: "test-key",
    }
  )
  expect(result.error).toContain("Codex CLI exited with code 1")
  expect(result.stderr).toContain("fixture authentication failed")
  expect(result.requests).toBe(0)
})

test("automatic selection prefers Codex even when OpenRouter is configured", async () => {
  const f = await fixture()
  expect(
    await run(
      f,
      `let requests = 0; globalThis.fetch = async () => { requests++; return Response.json({error: {message: "fixture unauthorized"}}, {status: 401}); }; const provider = activeProvider(); const text = await promptText("hello"); console.log(JSON.stringify({provider, text, requests}));`,
      {
        OPENROUTER_API_KEY: "test-key",
      }
    )
  ).toEqual({ provider: "codex", text: "compatible", requests: 0 })
})

test.each([
  "failed",
  "missing",
])("automatic selection falls back to OpenRouter when Codex is %s", async (mode) => {
  const f = await fixture()
  expect(
    await run(
      f,
      `let requests = 0; globalThis.fetch = async () => { requests++; return Response.json({id: "fallback", model: "openrouter/auto", created: 0, choices: [{index: 0, finish_reason: "stop", message: {role: "assistant", content: "fallback"}}], usage: {prompt_tokens: 3, completion_tokens: 2, total_tokens: 5}}); }; const provider = activeProvider(); const text = await promptText("hello"); console.log(JSON.stringify({provider, text, requests}));`,
      {
        OPENROUTER_API_KEY: "test-key",
        ...(mode === "failed" ? { CODEX_STUB_MODE: "fail" } : { PATH: f.cwd }),
      }
    )
  ).toEqual({ provider: mode === "failed" ? "codex" : "openrouter", text: "fallback", requests: 1 })
  expect(await Bun.file(f.capture).exists()).toBe(mode === "failed")
})

test("Codex generation honors the timeout signal", async () => {
  const f = await fixture()
  const result = await run(
    f,
    `try { await promptText("hello", {provider: "codex", timeout: 1000}); console.log(JSON.stringify({aborted: false})); } catch { console.log(JSON.stringify({aborted: true})); }`,
    {
      CODEX_STUB_MODE: "hang",
    }
  )
  expect(result).toEqual({ aborted: true })
  expect(await Bun.file(f.capture).exists()).toBe(true)
})

test("Codex is suppressed by the no-backend guard", async () => {
  const f = await fixture()
  expect(
    await run(
      f,
      `console.log(JSON.stringify({provider: activeProvider("codex"), available: hasAiProvider()}));`,
      {
        AI_TEST_NO_BACKEND: "1",
      }
    )
  ).toEqual({ provider: null, available: false })
  expect(await Bun.file(f.capture).exists()).toBe(false)
})

test("missing Codex fails clearly without package-manager fallback", async () => {
  const f = await fixture()
  const result = await run(
    f,
    `try { activeProvider("codex"); console.log(JSON.stringify({error: null})); } catch (error) { console.log(JSON.stringify({error: String(error)})); }`,
    { PATH: f.cwd }
  )
  expect(result.error).toContain("codex CLI is not installed or not in PATH")
  expect(await Bun.file(f.capture).exists()).toBe(false)
})
