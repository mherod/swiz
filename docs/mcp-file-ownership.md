# Session file ownership over MCP

`FileOwnership` coordinates sessions working in the same directory. A session
can reserve exact files before editing, renew its reservation, inspect other
lanes, and release files for handoff. Start a fresh `swiz mcp` connection after
upgrading so the client discovers the new tool.

| Action | Meaning | Required arguments |
| --- | --- | --- |
| `list` (default) | Show active reservations and recent recorded edits | None |
| `claim` | Acquire free files or renew your existing reservations | `sessionId`, `paths` |
| `hold` | Renew only reservations you currently own | `sessionId`, `paths` |
| `release` | Release only your reservations | `sessionId`, `paths` |

Pass the actual agent session ID used by editing hooks (`session_id`). Do not
invent a new ID per call, use the shared project task-store key, or pass a peer's
ID. MCP does not supply an authenticated agent session identity; this is a
cooperative local coordination mechanism, not an authorisation boundary.

An optional `lane` describes the work, such as `authentication`. Ownership is
always keyed by session ID, not the lane label. `leaseSeconds` defaults to 1800
(30 minutes), with a range of 60–7200 seconds. Only `claim` and `hold` accept
these options. Renewal retains the lane when omitted and never shortens an
existing lease. Renew before expiry; an expired `hold` fails and requires a
fresh `claim`.

Example calls, using your current session's ID in place of `<session-id>`:

```json
{"action":"claim","sessionId":"<session-id>","lane":"authentication","paths":["src/auth.ts","src/auth.test.ts"]}
{"action":"hold","sessionId":"<session-id>","paths":["src/auth.ts","src/auth.test.ts"],"leaseSeconds":1800}
{"action":"list","paths":["src/auth.ts"]}
{"action":"release","sessionId":"<session-id>","paths":["src/auth.ts","src/auth.test.ts"]}
```

Paths are exact files, relative to the resolved MCP project or absolute within
it. New files are supported. Dot segments and symlink aliases resolve to one
file identity. Directories, globs and paths outside the project are rejected.
Mutations accept at most 100 paths and require a nonempty explicit selection;
omitting paths never releases an entire session. `list` can omit paths to show
all lanes, and an optional `sessionId` does not hide peers.

Every mutation is atomic across its selected files. If any file has an active
peer lease, none of the files change. `hold` also refuses the whole batch when
any lease is missing or expired. Results include owners, lanes, expiry timestamps,
conflicts and missing leases. There is no force takeover or peer-release action.
Repeated release of already free files succeeds without changes. After release
or expiry another session can claim the file.

Reservations live in the `session_file_claims` table of the existing
`~/.swiz/issues.db`. An immediate SQLite transaction serialises competing
processes, including the daemon and local MCP fallback. Database failures return
an error rather than claiming success. Project resolution uses the MCP roots
and existing daemon caller-directory recovery; unresolved calls are refused.

The existing `session_edits` ledger remains independent. Recent recorded edits
are returned alongside leases, so inspect them and the actual diff before
claiming a file: obtaining a reservation does not authorise overwriting a peer's
changes. Releasing a reservation does not delete edits, modify file contents,
stage files, or commit work.

Active reservations take precedence in existing dirty-file ownership checks.
Without a reservation, the existing latest-edit attribution and two-hour peer
window still apply. The concurrent file-edit hook denies edits to active peer
reservations; it continues to provide advisory context for recent edits without
a reservation. File hooks must be installed and enabled for enforcement. Shell
commands, external editors and other clients that bypass those hooks are not
filesystem-locked by this tool.
