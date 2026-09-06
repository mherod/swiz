/** Shared cumulative Codex usage fixture for historical preview and append tests. */
export function sessionUsageLine(
  output: number,
  timestamp = "2026-09-07T10:00:00Z",
  input = 100,
  cachedInput = 30
): string {
  return JSON.stringify({
    type: "event_msg",
    timestamp,
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          total_tokens: input + output,
          input_tokens: input,
          output_tokens: output,
          cached_input_tokens: cachedInput,
        },
      },
    },
  })
}
