import type { SwizHook } from "../../SwizHook.ts"

/** Test fixture (#924): reports the HOME a hook run sees, so runner sandboxing can be asserted. */
const echoHomeHook: SwizHook = {
  name: "echo-home-fixture",
  event: "preToolUse",
  run: () => ({ systemMessage: process.env.HOME ?? "" }),
}

export default echoHomeHook
