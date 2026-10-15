import { stripInternalDispatchFields } from "./dispatch-wire.ts"

/** A CLI invocation owns stdout; dispatch execution never emits an envelope. */
let responseWritten = false

export function markDispatchResponseWritten(): void {
  responseWritten = true
}

export function resetDispatchResponseWriteState(): void {
  responseWritten = false
}

export function didWriteDispatchResponse(): boolean {
  return responseWritten
}

export function writeResponse(response: Record<string, any>): void {
  const agent = stripInternalDispatchFields(response)
  process.stdout.write(`${JSON.stringify(agent)}\n`)
  markDispatchResponseWritten()
}
