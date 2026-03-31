#!/usr/bin/env bun

import { z } from "zod"
import { promptObject } from "../src/ai-providers.ts"

async function main() {
  const a = await promptObject(
    "Hello, what's your name?",
    z.object({
      foo: z.string(),
    })
  )
  console.log(a)
}

if (import.meta.main) await main().catch(console.error)
