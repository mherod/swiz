import { messageFromUnknownError } from "../../utils/hook-json-helpers.ts"
import {
  type DispatchPayloadWorkerRequest,
  type DispatchPayloadWorkerResponse,
  type NormalizedDispatchPayload,
  normalizeParsedDispatchPayload,
} from "./worker-runtime.ts"

function normalizeDispatchPayload(payloadStr: string): NormalizedDispatchPayload | null {
  return normalizeParsedDispatchPayload(JSON.parse(payloadStr) as Record<string, any>)
}

self.onmessage = (event: MessageEvent<DispatchPayloadWorkerRequest>) => {
  const req = event.data
  if (!req || req.kind !== "parse-dispatch-payload") return

  let response: DispatchPayloadWorkerResponse
  try {
    response = {
      id: req.id,
      ok: true,
      payload: normalizeDispatchPayload(req.payloadStr),
    }
  } catch (error) {
    response = {
      id: req.id,
      ok: false,
      error: messageFromUnknownError(error),
    }
  }

  self.postMessage(response)
}
