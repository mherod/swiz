import { getLaunchAgentPlistPath, SWIZ_DAEMON_LABEL } from "../../../launch-agents.ts"
import {
  DAEMON_OPENROUTER_API_KEY_ENV,
  daemonLaunchAgentPlistHasDirectBypass,
  daemonLaunchAgentPlistHasOpenRouterApiKey,
} from "../../install/daemon-helpers.ts"
import type { DiagnosticCheck } from "../types.ts"

export const daemonLaunchAgentEnvCheck: DiagnosticCheck = {
  name: "daemon-launch-agent-env",
  async run() {
    const plistPath = getLaunchAgentPlistPath(SWIZ_DAEMON_LABEL)
    const file = Bun.file(plistPath)
    if (!(await file.exists())) {
      return {
        name: "Daemon LaunchAgent env",
        status: "pass",
        detail: "LaunchAgent not installed",
      }
    }

    try {
      const plist = await file.text()
      // The LaunchAgent execs `bun run <indexPath> daemon`, which the globally-linked-command
      // guard rejects. Without the documented bypass launchd restarts it every ThrottleInterval
      // forever, and every other daemon check still reports healthy.
      if (!daemonLaunchAgentPlistHasDirectBypass(plist)) {
        return {
          name: "Daemon LaunchAgent env",
          status: "fail",
          detail:
            "SWIZ_DIRECT missing; daemon crash-loops on the global-link guard — run swiz daemon --install",
        }
      }
      if (daemonLaunchAgentPlistHasOpenRouterApiKey(plist)) {
        return {
          name: "Daemon LaunchAgent env",
          status: "pass",
          detail: `${DAEMON_OPENROUTER_API_KEY_ENV} present`,
        }
      }
      return {
        name: "Daemon LaunchAgent env",
        status: "warn",
        detail: `${DAEMON_OPENROUTER_API_KEY_ENV} missing; run swiz daemon --install with it set`,
      }
    } catch (err) {
      return {
        name: "Daemon LaunchAgent env",
        status: "fail",
        detail: `could not read ${plistPath}: ${err}`,
      }
    }
  },
}
