import { expect, test } from "bun:test"
import { parseTimestampMs } from "./timestamp.ts"

test.each([0, -1, 1.5, 1_700_000_000_000])("preserves finite milliseconds %s", (value) => {
  expect(parseTimestampMs(value)).toBe(value)
})

test.each([
  "1970-01-01T00:00:00Z",
  "1970-01-01T01:00:00+01:00",
])("parses date strings with timezone: %s", (value) => {
  expect(parseTimestampMs(value)).toBe(0)
})

test.each(
  [
    null,
    undefined,
    "",
    "   ",
    "not a date",
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    true,
    {},
    [],
    new Date(0),
  ].map((value) => [value] as const)
)("rejects absent or invalid timestamps: %p", (value) => {
  expect(parseTimestampMs(value)).toBeNull()
})
