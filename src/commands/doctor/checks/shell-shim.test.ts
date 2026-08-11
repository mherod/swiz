import { describe, expect, test } from "bun:test"
import { join, resolve } from "node:path"
import { useTempDir } from "../../../utils/test-utils.ts"
import { inspectShimInstallation } from "../../shim.ts"
import { checkShellShim } from "./shell-shim.ts"

const SHIM_PATH = resolve(import.meta.dir, "../../../../hooks/shim.sh")
const tmp = useTempDir("swiz-doctor-shell-shim-")

describe("Doctor shell shim check", () => {
  test("reports a missing installation with the Doctor repair command", async () => {
    const home = await tmp.create()
    const result = await checkShellShim({
      fix: false,
      home,
      shell: "/bin/zsh",
      shimPath: SHIM_PATH,
    })
    expect(result.status).toBe("warn")
    expect(result.detail).toContain("swiz doctor --fix")
  })

  test("repairs installation through Doctor and preserves a backup", async () => {
    const home = await tmp.create()
    const profile = join(home, ".zshenv")
    await Bun.write(profile, "export EXISTING=1\n")

    const result = await checkShellShim({
      fix: true,
      home,
      shell: "/bin/zsh",
      shimPath: SHIM_PATH,
    })
    expect(result.status).toBe("pass")
    expect(result.detail).toContain("repaired")
    expect(await Bun.file(`${profile}.bak`).text()).toBe("export EXISTING=1\n")
    expect(
      (await inspectShimInstallation({ home, shell: "/bin/zsh", shimPath: SHIM_PATH })).healthy
    ).toBe(true)
  })
})
