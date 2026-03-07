import { describe, expect, it } from "vitest"
import { createStreamBufferReporter } from "./stream-buffer-reporter.ts"

describe("createStreamBufferReporter", () => {
  it("emits submitting + buffered progress", () => {
    const writes: string[] = []
    const reporter = createStreamBufferReporter({
      write: (text) => {
        writes.push(text)
      },
      minIntervalMs: 0,
    })

    reporter.startSubmitting()
    reporter.onChunk("abc")
    reporter.finish()

    const output = writes.join("")
    expect(output).toContain("Submitting prompt to model...\n")
    expect(output).toContain("Buffering streamed response: 3 chars")
  })

  it("is silent when disabled", () => {
    const writes: string[] = []
    const reporter = createStreamBufferReporter({
      enabled: false,
      write: (text) => {
        writes.push(text)
      },
    })

    reporter.startSubmitting()
    reporter.onChunk("abc")
    reporter.finish()

    expect(writes).toEqual([])
  })
})
