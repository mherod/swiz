# Antigravity file editing hooks

Swiz installs `PreToolUse` and `PostToolUse` matchers for `write_to_file`,
`replace_file_content`, and `multi_replace_file_content`. Run
`swiz install --antigravity` to refresh an existing installation.

The tool events use nested matcher groups under the named `swiz` configuration.
Lifecycle events retain their flat handler lists. Reinstalling preserves user
handlers, including handlers sharing a matcher group with Swiz.

Native `toolCall.name` / `toolCall.args` payloads are normalized before existing
hooks run. `TargetFile`, `CodeContent`, replacement text, and camelCase session
metadata become the canonical fields those hooks consume. Native arguments and
artifact metadata remain available. Every replacement chunk is included in content
checks; file projections apply non-overlapping chunks against the original line
ranges, honour `AllowMultiple`, and support append writes. Ambiguous projections
return no projection, following the existing hook policy.

Pre-tool denials become Antigravity's top-level `decision: "deny"` with a reason.
Advisories leave the permission decision unset. Post-tool hooks still execute but
emit the empty response required by that event.

The adapter uses `agent-hook-schemas` 0.4.0 and the
[Antigravity hook contract](https://antigravity.google/docs/hooks). That version
does not export a multi-replacement schema, so Swiz derives its chunk schema from
the upstream single-replacement fields. The regression tests replay native payloads
through real Swiz guards; they do not launch an Antigravity model session.
