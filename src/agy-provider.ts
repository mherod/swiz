import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider"
import { z } from "zod"
import { collectProcessOutput } from "./utils/process-utils.ts"

const resultSchema = z.object({
  status: z.string(),
  response: z.string(),
  error: z.string().optional(),
  usage: z
    .object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      thinking_tokens: z.number(),
      cache_read_tokens: z.number(),
    })
    .optional(),
})

const GENERATION_AGENT = `---
name: swiz-generation
description: Generate text from supplied context
tools: [finish]
mainAgent: true
subagent: false
commandExecutionPolicy: off
mcpServers: []
skills: []
plugins: []
---
Generate only the requested answer from the supplied context. Do not use tools.
`

function formatPrompt(options: LanguageModelV4CallOptions): string {
  if (options.tools?.length) throw new Error("agy generation does not support tools")
  const messages = options.prompt.map((message) => {
    if (message.role === "system") return `system: ${message.content}`
    const text = message.content
      .map((part) => {
        if (part.type !== "text") throw new Error("agy generation supports text messages only")
        return part.text
      })
      .join("\n")
    return `${message.role}: ${text}`
  })
  if (options.responseFormat?.type === "json") {
    messages.push(
      `Return only JSON, without code fences.${options.responseFormat.schema ? ` Match this schema: ${JSON.stringify(options.responseFormat.schema)}` : ""}`
    )
  }
  return messages.join("\n\n")
}

function parseResult(stdout: string): LanguageModelV4GenerateResult {
  const result = resultSchema.parse(JSON.parse(stdout))
  if (result.status !== "SUCCESS")
    throw new Error(`agy ${result.status}: ${result.error ?? "generation failed"}`)
  if (!result.response.trim()) throw new Error("agy returned no text")
  const usage = result.usage
  return {
    content: [{ type: "text", text: result.response }],
    finishReason: { unified: "stop", raw: result.status },
    usage: {
      inputTokens: {
        total: usage?.input_tokens,
        noCache: undefined,
        cacheRead: usage?.cache_read_tokens,
        cacheWrite: undefined,
      },
      outputTokens: {
        total: usage?.output_tokens,
        text: usage ? Math.max(0, usage.output_tokens - usage.thinking_tokens) : undefined,
        reasoning: usage?.thinking_tokens,
      },
    },
    warnings: [],
  }
}

function attachAbort(proc: Bun.Subprocess, signal?: AbortSignal): () => void {
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const abort = () => {
    proc.kill("SIGINT")
    killTimer ??= setTimeout(() => proc.kill("SIGKILL"), 250)
  }
  signal?.addEventListener("abort", abort, { once: true })
  if (signal?.aborted) abort()
  return () => {
    signal?.removeEventListener("abort", abort)
    if (killTimer) clearTimeout(killTimer)
  }
}

async function generate(
  modelId: string,
  options: LanguageModelV4CallOptions
): Promise<LanguageModelV4GenerateResult> {
  const prompt = formatPrompt(options)
  options.abortSignal?.throwIfAborted()
  const executable = Bun.which("agy")
  if (!executable) throw new Error("The agy CLI is not installed or not in PATH.")
  const cwd = await mkdtemp(join(tmpdir(), "swiz-agy-generation-"))
  try {
    await mkdir(join(cwd, ".agents/agents"), { recursive: true })
    await Bun.write(join(cwd, ".agents/agents/swiz-generation.md"), GENERATION_AGENT)
    options.abortSignal?.throwIfAborted()
    const proc = Bun.spawn(
      [
        executable,
        "--agent",
        "swiz-generation",
        "--print",
        prompt,
        "--output-format",
        "json",
        "--disable-slash-commands",
        "--sandbox",
        "--model",
        modelId,
        "--effort",
        typeof options.reasoning === "string" ? options.reasoning : "low",
      ],
      { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" }
    )
    const detachAbort = attachAbort(proc, options.abortSignal)
    try {
      const { stdout, stderr, exitCode } = await collectProcessOutput(proc)
      options.abortSignal?.throwIfAborted()
      if (exitCode !== 0)
        throw new Error(`agy exited ${exitCode}: ${stderr.trim() || stdout.trim()}`)
      return parseResult(stdout)
    } finally {
      detachAbort()
      if (proc.exitCode === null) proc.kill("SIGKILL")
      await proc.exited
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

/** Print mode buffers one completed answer; the SDK stream emits that answer as one delta. */
export function createAgyModel(
  modelId = process.env.AGY_MODEL ?? "gemini-3.8-flash-low"
): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "agy",
    modelId,
    supportedUrls: {},
    doGenerate: (options) => generate(modelId, options),
    async doStream(options) {
      const result = await generate(modelId, options)
      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: result.warnings })
            controller.enqueue({ type: "text-start", id: "answer" })
            for (const part of result.content) {
              if (part.type === "text")
                controller.enqueue({ type: "text-delta", id: "answer", delta: part.text })
            }
            controller.enqueue({ type: "text-end", id: "answer" })
            controller.enqueue({
              type: "finish",
              finishReason: result.finishReason,
              usage: result.usage,
            })
            controller.close()
          },
        }),
      }
    },
  }
}
