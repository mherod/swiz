import { z } from "zod"

const transcriptLineRoleSchema = z.looseObject({
  type: z.string().optional(),
  role: z.string().optional(),
  message: z
    .looseObject({
      role: z.string().optional(),
    })
    .optional(),
})

function isUserEntry(line: string): boolean {
  if (!line.trim()) return false
  try {
    const parsed = transcriptLineRoleSchema.safeParse(JSON.parse(line))
    if (!parsed.success) return false
    const entry = parsed.data
    return entry.type === "user" || entry.role === "user" || entry.message?.role === "user"
  } catch {
    return false
  }
}

export function linesAfterLatestUserMessage(lines: string[]): string[] {
  let latestUserIndex = -1
  for (let i = 0; i < lines.length; i++) {
    if (isUserEntry(lines[i] ?? "")) latestUserIndex = i
  }

  return latestUserIndex === -1 ? lines : lines.slice(latestUserIndex + 1)
}
