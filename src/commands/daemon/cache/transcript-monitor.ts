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

interface MonitoringSettings {
  autoSteerEnabled: boolean
  maxConcurrent: number
  notificationsEnabled: boolean
  speakEnabled: boolean
}

function resolveMonitoringSettings(
  project: ProjectSwizSettings | null,
  global: Awaited<ReturnType<typeof readSwizSettings>>
): MonitoringSettings {
  return {
    autoSteerEnabled: project?.autoSteerTranscriptWatching ?? global.autoSteerTranscriptWatching,
    maxConcurrent:
      project?.transcriptMonitorMaxConcurrentDispatches ??
      global.transcriptMonitorMaxConcurrentDispatches ??
      0,
    notificationsEnabled: global.swizNotifyHooks,
    speakEnabled: project?.speak ?? global.speak,
  }
}

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

  /**
   * Get current transcript dispatch concurrency metrics (active, queued, max).
   * Used by daemon to expose metrics.
   */
  getDispatchConcurrencyMetrics(): {
    active: number
    queued: number
    maxConcurrent: number
  } {
    return {
      active: this.dispatchConcurrency.getActive(),
      queued: this.dispatchConcurrency.getQueueDepth(),
      maxConcurrent: this.dispatchConcurrency.getMaxConcurrent(),
    }
  }

  terminate(): void {}

  private latestToolCallMessage(data: {
    messages: Array<{ role: string; toolCalls?: Array<{ name: string; detail: string }> }>
  }) {
    return data.messages
      .slice(-10)
      .reverse()
      .find((message) => message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0)
  }

  private latestSpeakableMessage(data: { messages: Array<{ role: string; text: string }> }) {
    return data.messages
      .slice(-10)
      .reverse()
      .find(
        (message) => message.role === "assistant" && message.text && !isHookFeedback(message.text)
      )
  }

  private scheduleDispatch(
    canonicalEvent: "postToolUse" | "notification",
    payload: Record<string, unknown>,
    cwd: string,
    manifestGroups: HookGroup[]
  ): void {
    this.dispatchConcurrency.schedule(() =>
      executeDispatch({
        canonicalEvent,
        hookEventName: canonicalEvent,
        payloadStr: JSON.stringify(payload),
        daemonContext: true,
        manifestProvider: async (candidate: string) =>
          candidate === cwd ? manifestGroups : this.caches.manifestCache.get(candidate),
      })
    )
  }

  private async dispatchToolCallChange(
    cwd: string,
    session: Session,
    data: Awaited<ReturnType<typeof sessionDataCache.get>>,
    manifestGroups: HookGroup[]
  ): Promise<boolean> {
    if (!data?.lastToolCallFingerprint) return false
    const previous = this.lastToolCallFingerprints.get(session.id)
    if (previous === data.lastToolCallFingerprint) return false

    const message = `tool call fingerprint change in ${session.id}: ${previous} -> ${data.lastToolCallFingerprint}`
    stderrLog("tool call detection", `[daemon] ${message}`)
    void logPseudoHook(message)
    this.lastToolCallFingerprints.set(session.id, data.lastToolCallFingerprint)
    const toolCallMessage = this.latestToolCallMessage(data)
    const toolCall = toolCallMessage?.toolCalls?.[0]
    if (!toolCall) return false
    if (await this.isEventOnCooldown(manifestGroups, "postToolUse", cwd)) return true

    const trigger = `new tool call detected in ${session.id}, triggering auto-steer: ${toolCall.name}`
    stderrLog("postToolUse dispatch", `[daemon] ${trigger}`)
    void logPseudoHook(trigger)
    this.scheduleDispatch(
      "postToolUse",
      {
        session_id: session.id,
        transcript_path: session.path,
        cwd,
        tool_name: toolCall.name,
        tool_input: parseToolCallInput(toolCall.detail),
      },
      cwd,
      manifestGroups
    )
    return false
  }

  private async dispatchMessageChange(
    cwd: string,
    session: Session,
    data: Awaited<ReturnType<typeof sessionDataCache.get>>,
    manifestGroups: HookGroup[]
  ): Promise<void> {
    if (!data?.lastMessageFingerprint) return
    const previous = this.lastMessageFingerprints.get(session.id)
    if (previous === data.lastMessageFingerprint) return

    const message = `message fingerprint change in ${session.id}: ${previous} -> ${data.lastMessageFingerprint}`
    stderrLog("message detection", `[daemon] ${message}`)
    void logPseudoHook(message)
    this.lastMessageFingerprints.set(session.id, data.lastMessageFingerprint)
    const textMessage = this.latestSpeakableMessage(data)
    if (!textMessage || (await this.isEventOnCooldown(manifestGroups, "notification", cwd))) return

    const trigger = `new assistant message detected in ${session.id}, triggering speak`
    stderrLog("notification dispatch", `[daemon] ${trigger}`)
    void logPseudoHook(trigger)
    this.scheduleDispatch(
      "notification",
      {
        session_id: session.id,
        transcript_path: session.path,
        cwd,
        type: "assistant_message",
        message: textMessage.text,
      },
      cwd,
      manifestGroups
    )
  }

  async checkProject(cwd: string): Promise<void> {
    const [cached, globalSettings] = await Promise.all([
      this.caches.projectSettingsCache.get(cwd),
      readSwizSettings(),
    ])
    const settings = resolveMonitoringSettings(cached.settings, globalSettings)
    if (!settings.notificationsEnabled) return
    if (!settings.autoSteerEnabled && !settings.speakEnabled) return

    this.dispatchConcurrency.setMaxConcurrent(settings.maxConcurrent)

    const latestSession = await this.getLatestSession(cwd)
    if (!latestSession) return

    const [data, manifestGroups] = await Promise.all([
      sessionDataCache.get(latestSession),
      this.caches.manifestCache.get(cwd),
    ])
    if (!data) return

    if (settings.autoSteerEnabled) {
      const stoppedByCooldown = await this.dispatchToolCallChange(
        cwd,
        latestSession,
        data,
        manifestGroups
      )
      if (stoppedByCooldown) return
    }
    if (settings.speakEnabled) {
      await this.dispatchMessageChange(cwd, latestSession, data, manifestGroups)
    }
  }
}
