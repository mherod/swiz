# Daemon memory pressure

The daemon samples memory every 30 seconds. It records the runtime's RSS,
heapUsed, external and arrayBuffers counters separately from OS RSS obtained
with a bounded `ps -o rss= -p <self-pid>` query. The larger RSS drives pressure
detection. A denied or unavailable OS query is reported as null, not zero.

`GET /memory` serves a small, cached diagnostic snapshot without walking caches,
reading transcripts, pruning, or waiting for worker replies. The same pressure
and runtime summaries appear in `/metrics`. No transcript contents, paths,
session identifiers or secrets appear in the memory snapshot.

Three consecutive samples at or above 4 GiB enter degraded mode. The daemon
pauses new periodic and watcher-triggered transcript checks, clears reconstructible
file/history/index/snapshot caches, and returns 503 with Retry-After for
`/sessions/projects`, `/sessions/messages`, `/transcript/index`, and
`/status-line/snapshot`. Health, memory diagnostics, dispatch and task operations
remain available. Already admitted work can finish; pending durable writes,
task files, issue databases and CI subscriptions are not discarded.

Three consecutive samples at or below 3 GiB, and at least five minutes since
entering pressure, permit resumption. Samples in between reset the low-water
confirmation. If OS RSS was available during pressure, missing OS samples cannot
clear the alarm using a possibly understated runtime reading. Relief runs once
per pressure episode, rather than repeatedly flushing caches on every poll.

Set these environment variables before starting or restarting the daemon:

| Variable | Default | Meaning |
| --- | --- | --- |
| SWIZ_DAEMON_MEMORY_LIMIT_MB | 4096 | High threshold in MiB |
| SWIZ_DAEMON_MEMORY_RESUME_MB | 3072 | Low threshold in MiB; must be below the high threshold |
| SWIZ_DAEMON_MEMORY_CONFIRMATIONS | 3 | Consecutive samples to enter or leave pressure |
| SWIZ_DAEMON_MEMORY_COOLDOWN_MS | 300000 | Minimum degraded duration |
| SWIZ_DAEMON_MEMORY_INTERVAL_MS | 30000 | Sampling interval, at least 1000 ms |

All values must be positive integers. Invalid configuration fails startup.

The runtime snapshot identifies its partial measurement coverage explicitly:
main-isolate file-cache entries and estimated string bytes, transcript-index and
snapshot entry counts, active hook dispatches, pending persistence writes, and
the latest transcript-worker heartbeat. Worker counters include runtime-reported
heap/external/arrayBuffer values, file-cache counts, active checks, pending parent
RPCs, and active/queued dispatches. Worker snapshots expire after 90 seconds.
Other workers' memory is null because those isolates are not instrumented.
String-byte counts estimate UTF-16 content storage, not allocator overhead.
Do not sum worker RSS or infer an allocation owner from these partial counters.

## Session previews

Dashboard previews read at most the newest 8 MiB of a JSONL transcript, plus
one boundary byte, before parsing. A partial first record is discarded. This
prevents a multi-gigabyte history from being loaded just to display 300 recent
messages. At most two previews load concurrently across projects. Non-JSONL
documents larger than 8 MiB are unavailable as previews; they cannot safely be
parsed from a suffix. Original transcript files remain intact.

The preview cache has a shared 32 MiB estimated string budget as well as its
entry limit. `/memory` reports `sessionCacheEntries` and
`sessionCacheEstimatedBytes`. Pressure relief invalidates pending cache fills
and skips queued preview reads. Latest token totals remain cumulative provider
values; tokens per minute uses the first and last usage samples within the
preview window. Message timestamps and tool counts describe that recent window.

Run `bun scripts/debug-session-preview-memory.ts 32` to compare three cold
preview reads of a synthetic 32 MiB history. It prints memory counters and
checks that the latest message survives; it does not read user transcripts.

This is bounded degradation, not a hard process-memory cap or a fix for an
unprofiled native leak. It does not force GC or terminate admitted work. If RSS
stays high, inspect `/memory`, drain active work, and use `swiz daemon --restart`
under the normal operator/supervisor lifecycle. Automatic forced recycling is
deliberately avoided because the existing shutdown path has a bounded telemetry
flush and could otherwise lose pending writes. The observed OS/runtime RSS gap
does not establish that a particular worker, cache, allocator or watch loop is
the cause. Full cache bounding and worker RPC recovery remain tracked separately
in issues 814 and 854.
