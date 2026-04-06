import { stderrLog } from "../../../debug.ts"
import { executeDispatch } from "../../../dispatch/index.ts"
import type { HookGroup } from "../../../hook-types.ts"
import { hookIdentifier, isInlineHookDef } from "../../../hook-types.ts"
import type { ProjectSwizSettings } from "../../../settings/types.ts"
import { readSwizSettings } from "../../../settings.ts"
import type { Session } from "../../../transcript-utils.ts"
import { findAllProviderSessions, isHookFeedback } from "../../../transcript-utils.ts"
import { CappedMap } from "../../../utils/capped-map.ts"
import { logPseudoHook } from "../daemon-logging.ts"
import { sessionDataCache } from "../session-data.ts"
import { transcriptWatchPathsForProject } from "../utils.ts"
import { TranscriptDispatchConcurrencyGate } from "./transcript-dispatch-concurrency.ts"

function parseToolCallInput(detailStr: string | undefined): Record<string, any> {
  if (!detailStr) return {}
  try {
    const parsed = JSON.parse(detailStr)
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, any>
    }
  } catch {
    // detail may be a truncated summary string
  }
  return {}
}

/**
 * Monitors session transcripts for new tool calls and triggers auto-steer.
 */
export class TranscriptMonitor {
  private lastToolCallFingerprints = new CappedMap<string, string>(100)
  private lastMessageFingerprints = new CappedMap<string, string>(100)
  private latestSessionCache = new Map<string, { session: Session; mtimeMs: number }>()
  private readonly dispatchConcurrency = new TranscriptDispatchConcurrencyGate()

  constructor(
    private caches: {
      manifestCache: { get: (cwd: string) => Promise<HookGroup[]> }
      cooldownRegistry: {
        checkAndMark: (id: string, cooldown: number, cwd: string) => boolean | Promise<boolean>
      }
      projectSettingsCache: {
        get: (cwd: string) => Promise<{ settings: ProjectSwizSettings | null }>
      }
    }
  ) {}

  private async getLatestSession(cwd: string): Promise<Session | null> {
    const cached = this.latestSessionCache.get(cwd)
    // Check if the transcript directories have changed since we last scanned
    const watchPaths = transcriptWatchPathsForProject(cwd)
    // Stat all watch paths concurrently — they are independent directories
    const mtimes = await Promise.all(
      watchPaths.map(async (watch) => {
        try {
          const s = await Bun.file(watch.path).stat()
          return s.mtimeMs ?? 0
        } catch {
          return 0 // Path might not exist or be unreadable
        }
      })
    )
    const maxMtime = Math.max(0, ...mtimes)

    if (cached && cached.mtimeMs >= maxMtime) {
      // Confirm the cached session path still exists
      if (await Bun.file(cached.session.path).exists()) {
        return cached.session
      }
    }

    const sessions = await findAllProviderSessions(cwd, undefined, 1)
    const latest = sessions[0]
    if (latest) {
      this.latestSessionCache.set(cwd, { session: latest, mtimeMs: maxMtime })
    } else {
      this.latestSessionCache.delete(cwd)
    }
    return latest ?? null
  }

  /**
   * Returns true if any hook for the given event is within its cooldown window (dispatch should be skipped).
   * Marks the cooldown for the first non-cooled hook when returning false.
   */
  private async isEventOnCooldown(
    manifestGroups: HookGroup[],
    event: string,
    cwd: string
  ): Promise<boolean> {
    const groups = manifestGroups.filter((g) => g.event === event)
    for (const group of groups) {
      for (const hook of group.hooks) {
        const cooldown = isInlineHookDef(hook)
          ? (hook.hook.cooldownSeconds ?? 30)
          : (hook.cooldownSeconds ?? 30)
        const id = hookIdentifier(hook)
        const raw = this.caches.cooldownRegistry.checkAndMark(id, cooldown, cwd)
        const withinCooldown = await Promise.resolve(raw)
        if (withinCooldown) {
          void logPseudoHook(`${event} cooldown active for ${id} in ${cwd}, skipping`)
          stderrLog(
            "hook cooldown active",
            `[daemon] ${event} cooldown active for ${id}, skipping dispatch`
          )
          return true
        }
      }
    }
    return false
  }

  pruneOldSessions(activeSessions: Set<string>): void {
    for (const sessionId of this.lastToolCallFingerprints.keys()) {
      if (!activeSessions.has(sessionId)) {
        this.lastToolCallFingerprints.delete(sessionId)
        this.lastMessageFingerprints.delete(sessionId)
      }
    }
    for (const [cwd, cached] of this.latestSessionCache) {
      if (!activeSessions.has(cached.session.id)) {
        this.latestSessionCache.delete(cwd)
      }
    }
  }

  terminate(): void {}

  async checkProject(cwd: string): Promise<void> {
    const [cached, globalSettings] = await Promise.all([
      this.caches.projectSettingsCache.get(cwd),
      readSwizSettings(),
    ])
    const settings = cached.settings
    if (!globalSettings.swizNotifyHooks) return
    const autoSteerEnabled =
      settings?.autoSteerTranscriptWatching ?? globalSettings.autoSteerTranscriptWatching
    const speakEnabled = settings?.speak ?? globalSettings.speak
    if (!autoSteerEnabled && !speakEnabled) return

    this.dispatchConcurrency.setMaxConcurrent(
      settings?.transcriptMonitorMaxConcurrentDispatches ??
        globalSettings.transcriptMonitorMaxConcurrentDispatches ??
        0
    )

    const latestSession = await this.getLatestSession(cwd)
    if (!latestSession) return

    const [data, manifestGroups] = await Promise.all([
      sessionDataCache.get(latestSession),
      this.caches.manifestCache.get(cwd),
    ])
    if (!data) return

    if (autoSteerEnabled && data.lastToolCallFingerprint) {
      const prevFingerprint = this.lastToolCallFingerprints.get(latestSession.id)
      if (prevFingerprint !== data.lastToolCallFingerprint) {
        const msg = `tool call fingerprint change in ${latestSession.id}: ${prevFingerprint} -> ${data.lastToolCallFingerprint}`
        stderrLog("tool call detection", `[daemon] ${msg}`)
        void logPseudoHook(msg)
        this.lastToolCallFingerprints.set(latestSession.id, data.lastToolCallFingerprint)
        let toolCallMessage: (typeof data.messages)[0] | undefined
        for (let i = data.messages.length - 1; i >= Math.max(0, data.messages.length - 10); i--) {
          const msg = data.messages[i]
          if (msg && msg.role === "assistant" && (msg.toolCalls?.length ?? 0) > 0) {
            toolCallMessage = msg
            break
          }
        }

        if (toolCallMessage) {
          if (await this.isEventOnCooldown(manifestGroups, "postToolUse", cwd)) return
          const triggerMsg = `new tool call detected in ${latestSession.id}, triggering auto-steer: ${toolCallMessage.toolCalls![0]!.name}`
          stderrLog("postToolUse dispatch", `[daemon] ${triggerMsg}`)
          void logPseudoHook(triggerMsg)
          const toolName = toolCallMessage.toolCalls![0]!.name
          const payload = {
            session_id: latestSession.id,
            transcript_path: latestSession.path,
            cwd,
            tool_name: toolName,
            tool_input: parseToolCallInput(toolCallMessage.toolCalls![0]!.detail),
          }

          this.dispatchConcurrency.schedule(() =>
            executeDispatch({
              canonicalEvent: "postToolUse",
              hookEventName: "postToolUse",
              payloadStr: JSON.stringify(payload),
              daemonContext: true,
              manifestProvider: async (c: string) =>
                c === cwd ? manifestGroups : this.caches.manifestCache.get(c),
            })
          )
        }
      }
    }

    if (speakEnabled && data.lastMessageFingerprint) {
      const prevMessageFingerprint = this.lastMessageFingerprints.get(latestSession.id)
      if (prevMessageFingerprint !== data.lastMessageFingerprint) {
        const msg = `message fingerprint change in ${latestSession.id}: ${prevMessageFingerprint} -> ${data.lastMessageFingerprint}`
        stderrLog("message detection", `[daemon] ${msg}`)
        void logPseudoHook(msg)
        this.lastMessageFingerprints.set(latestSession.id, data.lastMessageFingerprint)
        let textMessage: (typeof data.messages)[0] | undefined
        for (let i = data.messages.length - 1; i >= Math.max(0, data.messages.length - 10); i--) {
          const msg = data.messages[i]
          if (msg && msg.role === "assistant" && msg.text && !isHookFeedback(msg.text)) {
            textMessage = msg
            break
          }
        }

        if (textMessage) {
          if (await this.isEventOnCooldown(manifestGroups, "notification", cwd)) return
          const triggerMsg = `new assistant message detected in ${latestSession.id}, triggering speak`
          stderrLog("notification dispatch", `[daemon] ${triggerMsg}`)
          void logPseudoHook(triggerMsg)
          const payload = {
            session_id: latestSession.id,
            transcript_path: latestSession.path,
            cwd,
            type: "assistant_message",
            message: textMessage.text,
          }

          this.dispatchConcurrency.schedule(() =>
            executeDispatch({
              canonicalEvent: "notification",
              hookEventName: "notification",
              payloadStr: JSON.stringify(payload),
              daemonContext: true,
              manifestProvider: async (c: string) =>
                c === cwd ? manifestGroups : this.caches.manifestCache.get(c),
            })
          )
        }
      }
    }
  }
}
