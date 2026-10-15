import { messageFromUnknownError } from "../../utils/hook-json-helpers.ts"
import {
  type DispatchPayloadWorkerRequest,
  type DispatchPayloadWorkerResponse,
  parseDispatchPayload,
} from "./dispatch-payload.ts"

self.onmessage = (event: MessageEvent<DispatchPayloadWorkerRequest>) => {
  const req = event.data
  if (!req || req.kind !== "parse-dispatch-payload") return

  let response: DispatchPayloadWorkerResponse
  try {
    response = {
      id: req.id,
      ok: true,
      payload: parseDispatchPayload(req.payloadStr),
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
