import { expect, test } from "bun:test"
import { chmodSync } from "node:fs"
import { join } from "node:path"
import { createAgyModel } from "./agy-provider.ts"
import { useTempDir } from "./utils/test-utils.ts"

const tmp = useTempDir("swiz-agy-test-")
const provider = join(import.meta.dir, "ai-providers.ts")
const zod = Bun.resolveSync("zod", import.meta.dir)
const ai = Bun.resolveSync("ai", import.meta.dir)

async function run(code: string, mode = "success") {
  const dir = await tmp.create()
  const capture = join(dir, "capture.json")
  await Bun.write(
    join(dir, "agy"),
    `#!${process.execPath}
const args = process.argv.slice(2);
if (process.env.STUB_MODE === "hang") process.on("SIGINT", () => {});
await Bun.write(process.env.CAPTURE, JSON.stringify({pid:process.pid,cwd:process.cwd(),args,agent:await Bun.file(".agents/agents/swiz-generation.md").text()}));
if (process.env.STUB_MODE === "hang") { setInterval(() => {}, 1000); await Bun.write(process.env.CAPTURE + ".ready", "ready"); }
else if (process.env.STUB_MODE === "malformed") console.log("not json");
else if (process.env.STUB_MODE === "exit") { console.error("backend failed"); process.exitCode=3; }
else console.log(JSON.stringify({status:process.env.STUB_MODE === "error" ? "ERROR" : "SUCCESS",response:process.env.STUB_MODE === "empty" ? "" : '{"answer":"ok"}',error:"backend error",usage:{input_tokens:10,output_tokens:3,thinking_tokens:2,cache_read_tokens:4}}));
`,
    { mode: 0o755 }
  )
  chmodSync(join(dir, "agy"), 0o755)
  const proc = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `import {z} from ${JSON.stringify(zod)}; import {promptText,promptStreamText,promptObject,activeProvider,parseAiProvider} from ${JSON.stringify(provider)}; ${code}`,
    ],
    {
      cwd: dir,
      env: { HOME: dir, PATH: dir, AI_PROVIDER: "agy", CAPTURE: capture, STUB_MODE: mode },
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
  if (!(await Bun.file(capture).exists())) throw new Error(`Stub did not run: ${stderr || stdout}`)
  return { stdout, stderr, exitCode: proc.exitCode, capture: await Bun.file(capture).json() }
}

test("agy routes text, buffered streaming and validated objects through AI SDK", async () => {
  const r = await run(`
    const text=await promptText("hello",{model:"fixture-model"});
    const chunks=[];
    const stream=await promptStreamText("hello",{onTextPart:p=>chunks.push(p)});
    const object=await promptObject("hello",z.object({answer:z.literal("ok")}));
    console.log(JSON.stringify({text,stream,chunks,object,provider:activeProvider(),parsed:parseAiProvider("agy")}));
  `)
  expect(r.exitCode).toBe(0)
  expect(r.stderr).toBe("")
  expect(JSON.parse(r.stdout)).toEqual({
    text: '{"answer":"ok"}',
    stream: '{"answer":"ok"}',
    chunks: ['{"answer":"ok"}'],
    object: { answer: "ok" },
    provider: "agy",
    parsed: "agy",
  })
  expect(r.capture.args).toContain("--disable-slash-commands")
  expect(r.capture.args).toContain("--sandbox")
  expect(r.capture.args).not.toContain("--dangerously-skip-permissions")
  expect(r.capture.args).not.toContain("--print-timeout")
  expect(r.capture.agent).toContain("tools: [finish]")
  expect(r.capture.agent).toContain("commandExecutionPolicy: off")
  expect(r.capture.args[r.capture.args.indexOf("--print") + 1]).toContain('"const":"ok"')
  expect(await Bun.file(join(r.capture.cwd, ".agents/agents/swiz-generation.md")).exists()).toBe(
    false
  )
})

test.each(["error", "exit", "malformed", "empty"])("agy rejects %s output", async (mode) => {
  const r = await run(
    `try { await promptText("hello"); process.exitCode=1 } catch { console.log("rejected") }`,
    mode
  )
  expect(r.exitCode).toBe(0)
  expect(r.stdout.trim()).toBe("rejected")
})

test("agy abort terminates a child that ignores SIGINT and removes its workspace", async () => {
  const r = await run(
    `import {watch} from "node:fs";
    const controller = new AbortController();
    const watcher = watch(process.cwd(), (_, name) => {
      if (name === "capture.json.ready") controller.abort();
    });
    try { await promptText("hello", {signal:controller.signal}); process.exitCode=1 }
    catch (error) { console.log(error.name) }
    finally { watcher.close() }`,
    "hang"
  )
  expect(r.exitCode).toBe(0)
  expect(r.stdout.trim()).toBe("AbortError")
  expect(() => process.kill(r.capture.pid, 0)).toThrow()
  expect(await Bun.file(join(r.capture.cwd, ".agents/agents/swiz-generation.md")).exists()).toBe(
    false
  )
})

test("agy rejects schema-invalid responses", async () => {
  const r = await run(
    `try { await promptObject("hello",z.object({answer:z.number()})); process.exitCode=1 } catch { console.log("rejected") }`
  )
  expect(r.exitCode).toBe(0)
  expect(r.stdout.trim()).toBe("rejected")
})

test("agy preserves the model override and counts reasoning within output tokens", async () => {
  const r = await run(`
    import {generateText} from ${JSON.stringify(ai)};
    import {withProviderModel} from ${JSON.stringify(provider)};
    const result=await withProviderModel((model,provider,signal)=>generateText({model,prompt:"hello",abortSignal:signal}),{model:"fixture-model"});
    console.log(JSON.stringify(result.usage));
  `)
  expect(r.exitCode).toBe(0)
  expect(r.capture.args[r.capture.args.indexOf("--model") + 1]).toBe("fixture-model")
  expect(JSON.parse(r.stdout)).toMatchObject({
    inputTokens: 10,
    outputTokens: 3,
    outputTokenDetails: { reasoningTokens: 2, textTokens: 1 },
  })
})

test("agy rejects tools, non-text content and pre-aborted requests before spawning", async () => {
  const model = createAgyModel("fixture")
  await expect(
    model.doGenerate({
      prompt: [],
      tools: [{ type: "function", name: "read", inputSchema: { type: "object" } }],
    })
  ).rejects.toThrow("does not support tools")
  await expect(
    model.doGenerate({
      prompt: [
        {
          role: "user",
          content: [{ type: "file", mediaType: "image/png", data: { type: "data", data: "" } }],
        },
      ],
    })
  ).rejects.toThrow("text messages only")
  await expect(
    model.doGenerate({ prompt: [], abortSignal: AbortSignal.abort(new Error("cancelled")) })
  ).rejects.toThrow("cancelled")
})
