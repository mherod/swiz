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

/**
 * Monitors session transcripts for new tool calls and triggers auto-steer.
 */
export class TranscriptMonitor {
  private lastToolCallFingerprints = new CappedMap<string, string>(100)
  private lastMessageFingerprints = new CappedMap<string, string>(100)
  private latestSessionCache = new Map<string, { session: Session; mtimeMs: number }>()

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
    let maxMtime = 0
    for (const watch of watchPaths) {
      try {
        const stat = await Bun.file(watch.path).stat()
        maxMtime = Math.max(maxMtime, stat.mtimeMs ?? 0)
      } catch {
        // Path might not exist or be unreadable
      }
    }

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
    const cached = await this.caches.projectSettingsCache.get(cwd)
    const settings = cached.settings
    const globalSettings = await readSwizSettings()
    const autoSteerEnabled =
      settings?.autoSteerTranscriptWatching ?? globalSettings.autoSteerTranscriptWatching
    const speakEnabled = settings?.speak ?? globalSettings.speak
    if (!autoSteerEnabled && !speakEnabled) return

    const latestSession = await this.getLatestSession(cwd)
    if (!latestSession) return

    const [data, manifestGroups] = await Promise.all([
      sessionDataCache.get(latestSession),
      this.caches.manifestCache.get(cwd),
    ])
    if (!data) return

    void logPseudoHook(
      `checkProject: autoSteer=${autoSteerEnabled} speak=${speakEnabled} session=${latestSession.id} lastToolCallFingerprint=${data.lastToolCallFingerprint}`
    )

    if (autoSteerEnabled && data.lastToolCallFingerprint) {
      const prevFingerprint = this.lastToolCallFingerprints.get(latestSession.id)
      if (prevFingerprint !== data.lastToolCallFingerprint) {
        const msg = `tool call fingerprint change in ${latestSession.id}: ${prevFingerprint} -> ${data.lastToolCallFingerprint}`
        stderrLog("tool call detection", `[daemon] ${msg}`)
        void logPseudoHook(msg)
        this.lastToolCallFingerprints.set(latestSession.id, data.lastToolCallFingerprint)

        // Detect the recent tool call to avoid loops
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

          // Trigger postToolUse hook
          const triggerMsg = `new tool call detected in ${latestSession.id}, triggering auto-steer: ${toolCallMessage.toolCalls![0]!.name}`
          stderrLog("postToolUse dispatch", `[daemon] ${triggerMsg}`)
          void logPseudoHook(triggerMsg)
          const toolName = toolCallMessage.toolCalls![0]!.name
          const detailStr = toolCallMessage.toolCalls![0]!.detail
          let toolInput: Record<string, any> = {}
          if (detailStr) {
            try {
              const parsed = JSON.parse(detailStr)
              if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
                toolInput = parsed as Record<string, any>
              }
            } catch {
              // detail may be a truncated summary string — leave as empty object
            }
          }

          const payload = {
            session_id: latestSession.id,
            transcript_path: latestSession.path,
            cwd,
            tool_name: toolName,
            tool_input: toolInput,
          }

          void executeDispatch({
            canonicalEvent: "postToolUse",
            hookEventName: "postToolUse",
            payloadStr: JSON.stringify(payload),
            daemonContext: true,
            manifestProvider: async (cwd: string) => this.caches.manifestCache.get(cwd),
          })
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

        // Find the actual message for text
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

          // Trigger notification hook for TTS
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

          void executeDispatch({
            canonicalEvent: "notification",
            hookEventName: "notification",
            payloadStr: JSON.stringify(payload),
            daemonContext: true,
            manifestProvider: async (cwd: string) => this.caches.manifestCache.get(cwd),
          })
        }
      }
    }
  }
}
