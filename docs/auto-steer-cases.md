# Auto-Steer Cases

Auto-steer lets a hook (or command) push a follow-up instruction back into the
agent's session without waiting for the user to type. A message is *scheduled*
into a SQLite queue (`src/auto-steer-store.ts`) by a producer, then *delivered*
later by a consumer when its trigger condition is met. Delivery is either typed
into the terminal via AppleScript or pushed through the `swiz mcp` channel.

- **Producer entry points:** `scheduleAutoSteer()` and `scheduleAutoSteerViaChannel()` in `src/utils/auto-steer-helpers.ts`.
- **Queue:** `getAutoSteerStore()` in `src/auto-steer-store.ts` (dedup on the original message text via `dedupKey`).
- **Gating:** the `autoSteer` setting must be enabled; the MCP path additionally requires `mcpChannels`. If neither an AppleScript terminal nor the channel is available, the producer falls back to a hard deny / context emit.
- **Humanisation:** queued text is rewritten by `humaniseAutoSteerMessage()` (OpenRouter) before display; dedup still keys on the original text.

## Triggers

Every queued message carries a trigger that decides *when* it drains. Triggers
are defined in `src/auto-steer-store.ts`.

| Trigger | Delivered by | Fires when |
| --- | --- | --- |
| `asap` | `scheduleAutoSteer()` (immediate) | Delivered the moment it is scheduled — typed straight into the terminal without waiting for any dispatch or Stop event. Falls back to the MCP channel when no AppleScript terminal is present. |
| `next_turn` | `hooks/posttooluse-auto-steer.ts` | Every PostToolUse cycle (the default). |
| `after_commit` | `hooks/posttooluse-auto-steer.ts` | The PostToolUse tool was a Bash `git commit` (matched by `GIT_COMMIT_RE`). |
| `after_all_tasks_complete` | `hooks/posttooluse-auto-steer.ts` | All session tasks are `completed`/`cancelled` (and at least one task exists). |
| `task_created` | `hooks/posttooluse-auto-steer.ts` | The PostToolUse tool was a `TaskCreate`. |
| `task_updated` | `hooks/posttooluse-auto-steer.ts` | The PostToolUse tool was a `TaskUpdate`. |
| `task_completed` | `hooks/posttooluse-auto-steer.ts` | A `TaskUpdate` set the task `status` to `completed`. |
| `on_session_stop` | `src/dispatch/blockingStrategy.ts` | The Stop event; pending messages short-circuit (skip) the stop hooks and are typed to the terminal. |

### Delivery mechanism

A scheduled message reaches the agent through one of two transports:

- **AppleScript terminal** (preferred): the message is typed into the active
  iTerm2 / Terminal window. `asap` types immediately at schedule time; the other
  PostToolUse triggers drain on the next `postToolUse` cycle; `on_session_stop`
  drains at the Stop event.
- **MCP channel** (fallback when no AppleScript terminal): the message is
  enqueued and the `swiz mcp` server pushes it to the agent as a
  `<channel source="swiz">` event. Channel-deliverable triggers are defined once
  in `CHANNEL_DELIVERABLE_TRIGGERS` (`src/auto-steer-store.ts`) and consumed by
  both `swiz mcp` and the `scheduleAutoSteer` fallback. `on_session_stop` is
  excluded — by the time Stop fires the channel is tearing down with the session.

## Scheduled cases

Each row is a place in the codebase that schedules a steer, the trigger it uses,
and the condition under which the message is emitted.

| # | Case | Source | Trigger | Emitted when | Message intent |
| --- | --- | --- | --- | --- | --- |
| 1 | Offensive / lazy language | `hooks/pretooluse-offensive-language.ts:135` | `next_turn` (default) | The last assistant message matches a lazy/offensive language pattern before an Edit/Write/Bash. | Refined feedback on the wording plus "Demonstrate corrected behavior through action, not words." |
| 2 | Task requirement block | `hooks/pretooluse-task-governance.ts:261` (`denyAutoSteerOrBlock`) | `next_turn` (default) | Edit/Write/Bash attempted without a healthy task buffer (≥2 incomplete, ≥1 pending). | The task-governance requirement reason, steered instead of hard-denying when a transport exists. |
| 3 | Blocked `swiz tasks` CLI | `hooks/pretooluse-task-governance.ts:1566` | `next_turn` (default) | A blocked `swiz tasks` CLI command is attempted (native task tools should be used). | `SWIZ_TASKS_CLI_DENY_MESSAGE` directing the agent to native task tools. |
| 4 | Task-creation countdown | `hooks/posttooluse-task-advisor.ts:34` | `next_turn` (default) | After an Edit/Write, when no task tool has been used yet this session (calls-since-task ≥ total). | Countdown nudging the agent to `TaskCreate` before the threshold. |
| 5 | Sibling test reminder | `hooks/posttooluse-test-pairing.ts:78` | `after_commit` | A source file with an existing stale sibling test file is edited. | Reminds the agent to update the matching test — delivered after the next commit. |
| 6 | iMessage / transcript reply | `src/commands/transcript.ts:134` | `next_turn` | `swiz transcript` generates reply turns; each unique reply is queued. | Forwards the generated reply text as the next user-style turn. |
| 7 | Stop-block redelivery | `src/dispatch/blockingStrategy.ts` (`tryAutoSteerStopBlock`) | `on_session_stop` | A stop hook blocks with a reason at the Stop event. | The block reason is typed to the terminal and the block is converted to `allow`, so the agent keeps going. Dedup via `wasRecentlyDelivered`. |

### Notes

- **Task-advisor staleness warnings** (`posttooluse-task-advisor.ts`) are *not*
  steered — they pass `skipAutoSteer: true` and only emit PostToolUse context.
- **Foreground defer / re-queue:** if a steer is about to be typed while a chat
  app is the frontmost window, `deferAutoSteerWhenChatForeground()` re-schedules
  the same message (`next_turn`) instead of sending, so it is not lost.
- **`on_session_stop`** has no direct producer via `scheduleAutoSteer()`; it is
  driven entirely by the stop-block redelivery path (case 7) and its dedup
  bookkeeping in `blockingStrategy.ts`.
- **Channel vs terminal:** `scheduleAutoSteer()` prefers an AppleScript terminal
  and falls back to the MCP channel; `scheduleAutoSteerViaChannel()` always
  targets the channel. The channel-deliverable trigger set lives in
  `CHANNEL_DELIVERABLE_TRIGGERS` (`src/auto-steer-store.ts`) and `on_session_stop`
  is intentionally excluded from it.
- **`asap`:** delivered immediately at schedule time. On the terminal path it is
  enqueued (for dedup), atomically consumed, then typed in straight away rather
  than waiting for a PostToolUse/Stop dispatch.
