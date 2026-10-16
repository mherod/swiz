import { expect, test } from "bun:test"
import { join } from "node:path"
import { useTempDir } from "./utils/test-utils.ts"

const tmp = useTempDir("swiz-claude-provider-")
const providerPath = join(import.meta.dir, "ai-providers.ts")
const adapterPath = Bun.resolveSync("ai-sdk-provider-claude-code", import.meta.dir)
const zodPath = Bun.resolveSync("zod", import.meta.dir)

test.each([
  { mode: "native", text: '{"status":"ok"}', error: false },
  { mode: "prompt", text: '{"status":"ok"}', error: false },
  { mode: "prompt", text: '  ```json\n{"status":"ok"}\n```  ', error: false },
  { mode: "prompt", text: '```\r\n{"status":"ok"}\r\n```', error: false },
  { mode: "prompt", text: '```json\n{"status":}\n```', error: true },
  { mode: "prompt", text: '```json\n{"status":"wrong"}\n```', error: true },
  { mode: "prompt", text: 'Here is JSON:\n```json\n{"status":"ok"}\n```', error: true },
  { mode: "prompt", text: '```json\n{"status":"ok"}\n```\nExtra text', error: true },
])("Claude validates $mode response $text", async ({ mode, text, error }) => {
  const cwd = await tmp.create()
  const proc = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `import { mock, spyOn } from "bun:test";
       import { z } from ${JSON.stringify(zodPath)};
       spyOn(Bun, "which").mockImplementation(name => name === "claude" ? "/fixture/claude" : null);
       let captured, settings, reasoning, prompt;
       mock.module(${JSON.stringify(adapterPath)}, () => ({
         createClaudeCode: options => { settings = options.defaultSettings; return { languageModel: modelId => ({
           specificationVersion: "v4", provider: "claude-code", modelId,
           supportedUrls: {},
           async doGenerate(options) {
             captured = options.responseFormat;
             reasoning = options.reasoning;
             prompt = options.prompt;
             return {
               content: [{ type: "text", text: ${JSON.stringify(text)} }],
               finishReason: { unified: "stop", raw: "stop" },
               usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
               warnings: []
             };
           }
         }) }; }
       }));
       const { promptObject } = await import(${JSON.stringify(providerPath)});
       let result;
       try {
         result = await promptObject("Return status ok", z.object({ status: z.literal("ok") }), { provider: "claude", reasoning: "low", structuredOutput: ${JSON.stringify(mode)} });
       } catch (error) { result = { error: error.name }; }
       console.log(JSON.stringify({ result, format: captured, settings, reasoning, prompt }));`,
    ],
    {
      cwd,
      env: { HOME: cwd, PATH: "", AI_PROVIDER: "claude" },
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
  const { result, format, settings, reasoning, prompt } = JSON.parse(stdout)
  expect(reasoning).toBe("low")
  expect(settings).toMatchObject({
    tools: [],
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],
    permissionMode: "dontAsk",
  })
  if (error) expect(result.error).toBeDefined()
  else expect(result).toEqual({ status: "ok" })
  if (mode === "native") {
    expect(format.type).toBe("json")
    expect(format.schema.required).toEqual(["status"])
    expect(format.schema.properties.status.const).toBe("ok")
  } else {
    expect(format).toBeUndefined()
    expect(prompt[0].content[0].text).toContain('"const":"ok"')
  }
})
