# Changelog

## 2026-02-27

### Bug Fixes

- Fixed ESLint config-strength hook to recognise the modern flat config
  format (`eslint.config.js`). Projects using ESLint 9's flat config now
  have their rule-strength correctly enforced.
- Fixed Ruby debug-statement detection producing false positives on
  identifiers that contain "byebug" as a substring (e.g. helper method
  names). Only bare `byebug` and `binding.pry` calls are now flagged.

### Improvements

- Auto-continue suggestions now reference whichever skills are actually
  installed (e.g. `/changelog`, `/update-memory`) rather than showing
  generic advice, making autonomous next-step hints more actionable.
- Auto-continue analysis now incorporates changelog staleness awareness,
  prompting agents to update `CHANGELOG.md` when it has fallen behind.
- Session learnings are now written to persistent memory as part of the
  auto-continue workflow, so useful patterns are retained across sessions.
