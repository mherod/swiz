import { expect, spyOn, test } from "bun:test"
import { generateText, type LanguageModel, Output, streamText } from "ai"
import { z } from "zod"

type ModelFactory = () => Promise<Exclude<LanguageModel, string>>

const providers: Array<[string, ModelFactory]> = [
  [
    "OpenRouter chat",
    async () => {
      const { createOpenRouter } = await import("@openrouter/ai-sdk-provider")
      return createOpenRouter({ apiKey: "test-key" }).chat("openrouter/auto")
    },
  ],
  [
    "OpenRouter languageModel",
    async () => {
      const { createOpenRouter } = await import("@openrouter/ai-sdk-provider")
      return createOpenRouter({ apiKey: "test-key" }).languageModel("openrouter/free")
    },
  ],
  [
    "Google",
    async () => {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google")
      return createGoogleGenerativeAI({ apiKey: "test-key" })("gemini-2.5-flash")
    },
  ],
  [
    "Anthropic",
    async () => {
      const { createAnthropic } = await import("@ai-sdk/anthropic")
      return createAnthropic({ apiKey: "test-key" })("claude-sonnet-4-5")
    },
  ],
  [
    "Claude Code",
    async () => {
      const { createClaudeCode } = await import("ai-sdk-provider-claude-code")
      return createClaudeCode().languageModel("sonnet")
    },
  ],
  [
    "Gemini CLI",
    async () => {
      const { createGeminiProvider } = await import("ai-sdk-provider-gemini-cli")
      return createGeminiProvider({ authType: "api-key", apiKey: "test-key" })("gemini-2.5-flash")
    },
  ],
]

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 },
}
const finishReason = { unified: "stop", raw: "stop" } as const
type StreamChunk =
  | { type: "stream-start"; warnings: never[] }
  | { type: "text-start" | "text-end"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "finish"; finishReason: typeof finishReason; usage: typeof usage }

test.each([
  "chat",
  "languageModel",
] as const)("OpenRouter %s parses a backend response", async (kind) => {
  const { createOpenRouter } = await import("@openrouter/ai-sdk-provider")
  const requests: unknown[] = []
  const provider = createOpenRouter({
    apiKey: "test-key",
    fetch: Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)))
        return Response.json({
          id: "compatibility-check",
          model: "openrouter/auto",
          created: 0,
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: "compatible" },
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        })
      },
      { preconnect: () => {} }
    ),
  })
  const result = await generateText({
    model: provider[kind]("openrouter/auto"),
    prompt: "Check compatibility",
    maxRetries: 0,
  })
  expect(result.text).toBe("compatible")
  expect(result.usage.inputTokens).toBe(3)
  expect(result.usage.outputTokens).toBe(2)
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({ model: "openrouter/auto" })
})

// Keep the real installed model protocol and SDK adapter. Replace only backend
// execution so compatibility failures cannot be hidden by fixture early returns.
test.each(providers)("%s supports text and structured generation", async (_, createModel) => {
  const model = await createModel()
  const generate = spyOn(model, "doGenerate").mockResolvedValue({
    content: [{ type: "text", text: '{"answer":"compatible"}' }],
    finishReason,
    usage,
    warnings: [],
  })
  try {
    const text = await generateText({ model, prompt: "Check compatibility", maxRetries: 0 })
    expect(text.text).toBe('{"answer":"compatible"}')
    expect(text.usage.inputTokens).toBe(3)
    expect(text.usage.outputTokens).toBe(2)

    const structured = await generateText({
      model,
      prompt: "Return an answer",
      output: Output.object({ schema: z.object({ answer: z.string() }) }),
      maxRetries: 0,
    })
    expect(structured.output).toEqual({ answer: "compatible" })
    expect(generate).toHaveBeenCalledTimes(2)
  } finally {
    generate.mockRestore()
  }
})

test.each(providers)("%s supports streamed generation", async (_, createModel) => {
  const model = await createModel()
  const stream = spyOn(model, "doStream").mockResolvedValue({
    stream: new ReadableStream<StreamChunk>({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] })
        controller.enqueue({ type: "text-start", id: "answer" })
        controller.enqueue({ type: "text-delta", id: "answer", delta: "compatible" })
        controller.enqueue({ type: "text-end", id: "answer" })
        controller.enqueue({ type: "finish", finishReason, usage })
        controller.close()
      },
    }),
  })
  try {
    const result = streamText({ model, prompt: "Check compatibility", maxRetries: 0 })
    const parts: string[] = []
    for await (const part of result.textStream) parts.push(part)
    expect(parts).toEqual(["compatible"])
    expect((await result.usage).outputTokens).toBe(2)
    expect(stream).toHaveBeenCalledTimes(1)
  } finally {
    stream.mockRestore()
  }
})
