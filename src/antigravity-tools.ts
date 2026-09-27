import {
  AntigravityReplaceFileContentToolInputSchema,
  AntigravityWriteToFileToolInputSchema,
} from "agent-hook-schemas/antigravity"
import type { JsonObject } from "agent-hook-schemas/common"
import { z } from "zod"

// Select execution fields so optional descriptive metadata cannot hide an edit.
const replacementSchema = AntigravityReplaceFileContentToolInputSchema.pick({
  TargetContent: true,
  ReplacementContent: true,
  AllowMultiple: true,
  StartLine: true,
  EndLine: true,
})
const editSchema = replacementSchema.extend({ TargetFile: z.string() })
const writeSchema = AntigravityWriteToFileToolInputSchema.pick({
  TargetFile: true,
  CodeContent: true,
  Append: true,
})
// 0.4.0 has no multi-replacement schema; its chunks share the single-edit fields.
const multiEditSchema = z.object({
  TargetFile: z.string(),
  ReplacementChunks: z.array(replacementSchema).min(1),
})

export function normalizeAntigravityToolInput(name: string, input: JsonObject): JsonObject {
  if (name === "write_to_file") {
    const parsed = writeSchema.safeParse(input)
    if (parsed.success) {
      return {
        ...input,
        file_path: parsed.data.TargetFile,
        content: parsed.data.CodeContent,
        old_string: "",
        // Some shared schemas fill absent new_string with "" before delta guards run.
        new_string: parsed.data.CodeContent,
      }
    }
  }
  if (name === "replace_file_content") {
    const parsed = editSchema.safeParse(input)
    if (parsed.success) {
      return {
        ...input,
        file_path: parsed.data.TargetFile,
        old_string: parsed.data.TargetContent,
        new_string: parsed.data.ReplacementContent,
      }
    }
  }
  if (name === "multi_replace_file_content") {
    const parsed = multiEditSchema.safeParse(input)
    if (parsed.success) {
      return {
        ...input,
        file_path: parsed.data.TargetFile,
        old_string: parsed.data.ReplacementChunks.map((chunk) => chunk.TargetContent).join("\n"),
        new_string: parsed.data.ReplacementChunks.map((chunk) => chunk.ReplacementContent).join(
          "\n"
        ),
      }
    }
  }
  return input
}

type Replacement = z.infer<typeof replacementSchema>

function projectReplacements(current: string, chunks: Replacement[]): string | null {
  const lines = current.split("\n")
  let nextStart = lines.length + 1
  // Ranges refer to the original file, so apply the lowest ranges first.
  for (const chunk of [...chunks].sort((a, b) => b.StartLine - a.StartLine)) {
    const { StartLine: start, EndLine: end, TargetContent: oldText } = chunk
    if (start < 1 || end < start || end >= nextStart || !oldText) return null
    const region = lines.slice(start - 1, end).join("\n")
    if (!region.includes(oldText)) return null
    if (!chunk.AllowMultiple && region.indexOf(oldText) !== region.lastIndexOf(oldText)) return null
    const replacement = chunk.AllowMultiple
      ? region.replaceAll(oldText, () => chunk.ReplacementContent)
      : region.replace(oldText, () => chunk.ReplacementContent)
    lines.splice(start - 1, end - start + 1, ...replacement.split("\n"))
    nextStart = start
  }
  return lines.join("\n")
}

/** Project native edits without treating chunk concatenation as one replacement. */
export async function projectAntigravityFileContent(
  name: string,
  filePath: string,
  input: object
): Promise<string | null> {
  try {
    if (name === "write_to_file") {
      const parsed = writeSchema.safeParse(input)
      if (!parsed.success) return null
      if (!parsed.data.Append) return parsed.data.CodeContent
      const file = Bun.file(filePath)
      return ((await file.exists()) ? await file.text() : "") + parsed.data.CodeContent
    }
    const chunks =
      name === "replace_file_content"
        ? [editSchema.parse(input)]
        : multiEditSchema.parse(input).ReplacementChunks
    return projectReplacements(await Bun.file(filePath).text(), chunks)
  } catch {
    return null
  }
}
