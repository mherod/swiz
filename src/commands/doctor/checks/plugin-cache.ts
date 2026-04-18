import { buildPluginCacheResults, checkPluginCacheStaleness } from "../fix.ts"
import type { DiagnosticCheck } from "../types.ts"

export const pluginCacheCheck: DiagnosticCheck = {
  name: "plugin-cache",
  async run(ctx) {
    const infos = await checkPluginCacheStaleness()
    ctx.store.pluginCacheInfos = infos
    return buildPluginCacheResults(infos)
  },
}
