import { expect, test } from "bun:test"
import { join } from "node:path"
import { useTempDir } from "./utils/test-utils.ts"

const tmp = useTempDir("swiz-claude-provider-")
const providerPath = join(import.meta.dir, "ai-providers.ts")
const adapterPath = Bun.resolveSync("ai-sdk-provider-claude-code", import.meta.dir)
const zodPath = Bun.resolveSync("zod", import.meta.dir)

test("Claude receives a native object schema through the real AI SDK runner", async () => {
  const cwd = await tmp.create()
  const proc = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `import { mock, spyOn } from "bun:test";
       import { z } from ${JSON.stringify(zodPath)};
       spyOn(Bun, "which").mockImplementation(name => name === "claude" ? "/fixture/claude" : null);
       let captured;
       mock.module(${JSON.stringify(adapterPath)}, () => ({
         createClaudeCode: () => ({ languageModel: modelId => ({
           specificationVersion: "v4", provider: "claude-code", modelId,
           supportedUrls: {},
           async doGenerate(options) {
             captured = options.responseFormat;
             if (!captured?.schema) throw new Error("Claude requires a JSON schema");
             return {
               content: [{ type: "text", text: JSON.stringify({ status: "ok" }) }],
               finishReason: { unified: "stop", raw: "stop" },
               usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
               warnings: []
             };
           }
         }) })
       }));
       const { promptObject } = await import(${JSON.stringify(providerPath)});
       const result = await promptObject("Return status ok", z.object({ status: z.literal("ok") }), { provider: "claude" });
       console.log(JSON.stringify({ result, format: captured }));`,
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
  const { result, format } = JSON.parse(stdout)
  expect(result).toEqual({ status: "ok" })
  expect(format.type).toBe("json")
  expect(format.schema.required).toEqual(["status"])
  expect(format.schema.properties.status.const).toBe("ok")
})
