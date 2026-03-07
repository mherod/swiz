export interface StreamBufferReporter {
  startSubmitting: () => void
  onChunk: (textPart: string) => void
  finish: () => void
}

export interface StreamBufferReporterOptions {
  enabled?: boolean
  minIntervalMs?: number
  submittingMessage?: string
  bufferingLabel?: string
  write?: (text: string) => void
}

export function createStreamBufferReporter(
  options: StreamBufferReporterOptions = {}
): StreamBufferReporter {
  const enabled = options.enabled ?? true
  const minIntervalMs = options.minIntervalMs ?? 80
  const submittingMessage = options.submittingMessage ?? "Submitting prompt to model..."
  const bufferingLabel = options.bufferingLabel ?? "Buffering streamed response"
  const write = options.write ?? ((text: string) => process.stderr.write(text))

  let bufferedChars = 0
  let lastRenderMs = 0
  let submittingShown = false
  let bufferingShown = false

  const render = (final = false) => {
    if (!enabled) return
    const now = Date.now()
    if (!final && now - lastRenderMs < minIntervalMs) return
    lastRenderMs = now
    const line = `${bufferingLabel}: ${bufferedChars} chars`
    write(final ? `${line}\n` : `\r${line}`)
  }

  return {
    startSubmitting() {
      if (!enabled || submittingShown) return
      submittingShown = true
      write(`${submittingMessage}\n`)
    },
    onChunk(textPart: string) {
      if (!enabled) return
      bufferingShown = true
      bufferedChars += textPart.length
      render(false)
    },
    finish() {
      if (!enabled) return
      if (!bufferingShown) {
        write(`${bufferingLabel}: 0 chars\n`)
        return
      }
      render(true)
    },
  }
}
