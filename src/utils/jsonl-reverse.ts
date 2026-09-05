/** Reverse JSONL scans use fixed reads, including when no matching record exists. */
export const JSONL_REVERSE_CHUNK_BYTES = 256 * 1024
export const JSONL_REVERSE_MAX_RECORD_BYTES = 8 * 1024 * 1024

/**
 * Yield newest records first without repeatedly loading an expanding suffix.
 * Oversized records are skipped; optional history lookups must not allocate an
 * unbounded string for a single tool result. UTF-8 is decoded after joining bytes.
 */
export async function* reverseJsonlLines(
  file: Bun.BunFile,
  fileSize: number,
  chunkBytes = JSONL_REVERSE_CHUNK_BYTES,
  maxRecordBytes = JSONL_REVERSE_MAX_RECORD_BYTES
): AsyncIterableIterator<string> {
  if (chunkBytes < 1 || maxRecordBytes < 1) throw new Error("JSONL read limits must be positive")
  let end = fileSize
  let fragments: Uint8Array[] = []
  let recordBytes = 0
  const decoder = new TextDecoder()

  function add(fragment: Uint8Array): void {
    recordBytes += fragment.length
    if (recordBytes <= maxRecordBytes) fragments.push(fragment)
    else fragments = []
  }

  function finish(): string {
    let text = ""
    if (recordBytes > 0 && recordBytes <= maxRecordBytes) {
      const bytes = new Uint8Array(recordBytes)
      let offset = 0
      for (let i = fragments.length - 1; i >= 0; i--) {
        bytes.set(fragments[i]!, offset)
        offset += fragments[i]!.length
      }
      text = decoder.decode(bytes)
    }
    fragments = []
    recordBytes = 0
    return text
  }

  while (end > 0) {
    const start = Math.max(0, end - chunkBytes)
    const bytes = await file.slice(start, end).bytes()
    let lineEnd = bytes.length
    for (let i = bytes.length - 1; i >= 0; i--) {
      if (bytes[i] !== 10) continue
      add(bytes.subarray(i + 1, lineEnd))
      const line = finish()
      if (line) yield line
      lineEnd = i
    }
    add(bytes.subarray(0, lineEnd))
    end = start
  }
  const first = finish()
  if (first) yield first
}
