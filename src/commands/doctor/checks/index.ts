import type { DiagnosticCheck } from "../types.ts"
import { bunRuntimeCheck } from "./bun-runtime.ts"
import { ghAuthCheck } from "./gh-auth.ts"
import { ttsBackendCheck } from "./tts-backend.ts"

/** All pluggable diagnostic checks. Order determines display order. */
export const DIAGNOSTIC_CHECKS: DiagnosticCheck[] = [bunRuntimeCheck, ghAuthCheck, ttsBackendCheck]
