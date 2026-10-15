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
await Bun.write(process.env.CODEX_CAPTURE, JSON.stringify({args, schema, prompt, cwd:process.cwd(), pid:process.pid}))
if (process.env.CODEX_STUB_MODE === "hang") await new Promise(() => setInterval(() => {}, 1000))
if (process.env.CODEX_STUB_MODE === "fail") {
  console.error("fixture authentication failed")
  process.exit(1)
}
if (process.env.CODEX_STUB_MODE === "stream-error") {
  console.log(JSON.stringify({type: "turn.failed", error: {message: "fixture stream failed"}}))
  process.exit(0)
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
  expect(capture.args).toContain("--ignore-user-config")
  expect(capture.args).toContain("--ephemeral")
  expect(capture.cwd).not.toBe(f.cwd)
  expect(capture.args).toContain("features.shell_tool=false")
  expect(capture.args).toContain("features.plugins=false")
  expect(capture.args).toContain("features.apps=false")
  expect(capture.args).toContain("features.multi_agent=false")
  expect(capture.args).toContain("web_search=disabled")
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

test.each(["native", "prompt"] as const)("Codex passes the schema in %s mode", async (mode) => {
  const f = await fixture()
  expect(
    await run(
      f,
      `console.log(JSON.stringify(await promptObject("answer", z.object({answer: z.string()}), {structuredOutput:${JSON.stringify(mode)}, reasoning:"low"})));`,
      {
        AI_PROVIDER: "codex",
        CODEX_MODEL: "environment-model",
        CODEX_STUB_RESPONSE: '{"answer":"compatible"}',
      }
    )
  ).toEqual({ answer: "compatible" })
  const { args, schema, prompt } = await Bun.file(f.capture).json()
  expect(args[args.indexOf("-m") + 1]).toBe("environment-model")
  expect(args).toContain("model_reasoning_effort=low")
  if (mode === "native") {
    expect(schema).toMatchObject({
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    })
  } else {
    expect(schema).toBeNull()
    expect(args).not.toContain("--output-schema")
    expect(prompt).toContain('"required":["answer"]')
  }
})

test.each(["native", "prompt"] as const)("Codex rejects an invalid %s response", async (mode) => {
  const f = await fixture()
  const result = await run(
    f,
    `try { await promptObject("answer", z.object({answer: z.string()}), {structuredOutput:${JSON.stringify(mode)}}); console.log(JSON.stringify({rejected: false})); } catch { console.log(JSON.stringify({rejected: true})); }`,
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
  const { pid } = await Bun.file(f.capture).json()
  let running = true
  const deadline = Date.now() + 2000
  while (running && Date.now() < deadline) {
    try {
      process.kill(pid, 0)
      await Bun.sleep(20)
    } catch {
      running = false
    }
  }
  expect(running).toBe(false)
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

test.each([
  "fail",
  "stream-error",
])("Codex streaming surfaces %s instead of empty success", async (mode) => {
  const f = await fixture()
  const result = await run(
    f,
    `try { await promptStreamText("hello", {provider: "codex"}); console.log(JSON.stringify({rejected:false})); } catch (error) { console.log(JSON.stringify({rejected:true, error:String(error)})); }`,
    { CODEX_STUB_MODE: mode }
  )
  expect(result.rejected).toBe(true)
  expect(result.error).toContain(mode === "fail" ? "exited with code 1" : "fixture stream failed")
})

test("Codex streaming rejects empty replies", async () => {
  const f = await fixture()
  const result = await run(
    f,
    `try { await promptStreamText("hello", {provider: "codex"}); console.log(JSON.stringify({rejected:false})); } catch (error) { console.log(JSON.stringify({error:String(error)})); }`,
    { CODEX_STUB_RESPONSE: " " }
  )
  expect(result.error).toContain("returned no text")
})

test("auto-reply generates through Codex without scheduling", async () => {
  const f = await fixture()
  const result = await run(
    f,
    `const {streamAutoReply} = await import(${JSON.stringify(join(import.meta.dir, "commands/transcript.ts"))});
    console.log(JSON.stringify(await streamAutoReply([{role:"user",entry:{message:{role:"user",content:"Fix the test"}}}], {sessionId:"preview",flipRoles:false,cwd:${JSON.stringify(f.cwd)},passNumber:1})));`,
    { OPENROUTER_API_KEY: "test-key" }
  )
  expect(result).toHaveLength(1)
  expect(result[0].entry.message.content).toBe("compatible")
  expect((await Bun.file(f.capture).json()).prompt).toContain("Fix the test")
})

test("auto-reply propagates provider errors", async () => {
  const f = await fixture()
  const result = await run(
    f,
    `const {streamAutoReply} = await import(${JSON.stringify(join(import.meta.dir, "commands/transcript.ts"))});
    try { await streamAutoReply([], {sessionId:"preview",flipRoles:false,cwd:${JSON.stringify(f.cwd)},passNumber:1,provider:"codex"}); console.log(JSON.stringify({rejected:false})); } catch(error) { console.log(JSON.stringify({error:String(error)})); }`,
    { CODEX_STUB_MODE: "stream-error" }
  )
  expect(result.error).toContain("fixture stream failed")
})

test("steering uses Codex ahead of OpenRouter with a fresh cache", async () => {
  const f = await fixture()
  expect(
    await run(
      f,
      `const {humaniseAutoSteerMessage} = await import(${JSON.stringify(join(import.meta.dir, "utils/auto-steer-helpers.ts"))});
    console.log(JSON.stringify(await humaniseAutoSteerMessage("Run the regression tests.")));`,
      {
        OPENROUTER_API_KEY: "test-key",
        SWIZ_PROMPT_CACHE_DIR: join(f.cwd, "cache"),
        CODEX_STUB_RESPONSE: "Please run the regression tests, thanks.",
      }
    )
  ).toBe("Please run the regression tests, thanks.")
  expect((await Bun.file(f.capture).json()).prompt).toContain("Run the regression tests.")
  expect((await Bun.file(f.capture).json()).args).toContain("model_reasoning_effort=low")
})

test("auto-reply preserves no-tool generation when falling back to OpenRouter", async () => {
  const f = await fixture()
  const result = await run(
    f,
    `const {streamAutoReply} = await import(${JSON.stringify(join(import.meta.dir, "commands/transcript.ts"))});
    let request; globalThis.fetch = async (_, init) => { request=JSON.parse(init.body); const chunk={id:"fallback",model:"openrouter/auto",created:0,choices:[{index:0,delta:{role:"assistant",content:"Please verify the tests."},finish_reason:"stop"}]}; return new Response("data: "+JSON.stringify(chunk)+"\\n\\ndata: [DONE]\\n\\n",{headers:{"content-type":"text/event-stream"}}); };
    const replies = await streamAutoReply([], {sessionId:"preview",flipRoles:false,cwd:${JSON.stringify(f.cwd)},passNumber:1});
    console.log(JSON.stringify({replies,request}));`,
    { CODEX_STUB_MODE: "stream-error", OPENROUTER_API_KEY: "test-key" }
  )
  expect(result.replies[0].entry.message.content).toBe("Please verify the tests.")
  expect(result.request.messages.at(-1).content).toContain("Continue")
  expect(result.request.tools ?? []).toEqual([])
})

test("auto-reply print mode generates both passes without entering scheduling mode", async () => {
  const f = await fixture()
  const result = await run(
    f,
    `const {createCodexSession} = await import(${JSON.stringify(join(import.meta.dir, "test-fixtures.ts"))});
    const {transcriptCommand} = await import(${JSON.stringify(join(import.meta.dir, "commands/transcript.ts"))});
    const {runCommandInProcess} = await import(${JSON.stringify(join(import.meta.dir, "utils/test-utils.ts"))});
    await createCodexSession(${JSON.stringify(f.cwd)},${JSON.stringify(f.cwd)},"019cbc01-7777-7888-8999-444444444444",{assistantMessage:"Verify the test results."});
    const result = await runCommandInProcess(transcriptCommand,["--codex","--auto-reply","--print","--dir",${JSON.stringify(f.cwd)}],{commandOptions:{runAutoReplyMode:async()=>{throw new Error("scheduling mode reached")}}});
    console.log(JSON.stringify(result));`
  )
  expect(result.exitCode).toBe(0)
  expect(result.stdout.trim().split("\n")).toEqual(["compatible", "compatible"])
  expect(result.stderr).toBe("")
})
