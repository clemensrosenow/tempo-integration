# Implementation decisions

Where the spec (`tempo-spec.md`) left room, the integration decides as follows.
Each module also lists its decisions in a top-of-file comment.

## Planning (src/core)

- **Lock window (E8).** Past blocks and blocks running or starting within the next hour are never changed. Exception: a locked block that a busy fixed event now overlaps (meeting overrun) is moved out, since you can't work on it anyway. Nothing is ever created in, or moved into, the lock window. Future blocks of a checked-off task are always deleted.
- **Gaps.** Free time is working hours within [now + 1 h, now + horizon], minus busy fixed events (plus buffer), sleep and locked blocks. Free/declined/cancelled/all-day events count as available (E7). Other Tempo blocks count as free, because they are what gets re-placed.
- **Placement.** The LLM proposes placements and code checks them (max 2 retries). If the LLM fails, a deterministic greedy placer takes over. Ordering: deadline feasibility, urgency, priority, due. Urgent tasks (urgency ≥ 4 or due today) go first, so they land today if any gap exists (E5). Deep work prefers focus time. Learned hour affinity breaks ties.
- **Minimal change.** Still-valid blocks keep their place. Remaining need = estimate − minutes already worked in past blocks. Differences under 15 min don't move anything.
- **Subtasks (E4).** Each subtask is one atomic step, placed in Google Tasks order before the parent's due date. A parent with open subtasks has no blocks of its own.
- **Questions (E9/E10).**
  - At most one question is open at a time. Severity order: missed due date > dropped task > big change > unclear priority.
  - Slots always start at least 2 h ahead, so there is always ≥ 1 h to answer.
  - Maybe opens the next of up to 3 alternatives; with none left it means No.
  - No or timeout restores the hidden blocks exactly and records the rejection, so Tempo doesn't ask about that task again until the task is edited.
  - A big change holds the whole re-plan in one question.
- **Learning (E12).**
  - A resize sets the task's duration and updates a global duration scale (EMA α 0.3, clamped 0.5–3).
  - A drag adds affinity for that hour of day.
  - Either way the block stays where you put it, and its description gets a "Tempo learned: …" line.
  - A block that ends while its task is still open nudges the scale up.
- **Lapsed tasks.** A task overdue by more than 7 days is an old, forgotten to-do: it is not planned and raises no question. `tempo status` lists such tasks; a new due date brings them back. (Found live: a 190-day-old task produced an invitation.)
- **Stability first.** When a re-plan would move existing blocks, Tempo first tries to fit the new demand around the current plan. It only moves blocks (and only asks about a big change) if that would leave a task late or unplanned. (Found live: one new 30-min task moved four exam blocks by up to 6 days.)
- **Back-to-back blocks merge.** Adjacent blocks of one task become one block.
- **Missed-due options may take time from later work.** Work that is due later (or has no due) and isn't urgent may make room: the question says "To make room, Tempo moves '…' to later". Those blocks only move on Yes; while the question is open they stay. If the proposal is on time, the question reads "Make room for X before <due>?"; for an already overdue task "X is overdue. Do it today 16:50?".
- **Not big changes:** moves that follow from a Yes answer, moves of tasks the user just edited (e.g. due pulled earlier), and "rescue" moves that bring a block from after its due to before it.
- **Accepted lateness is explicit.** Blocks after the due are only kept without asking when the user answered Yes to a late proposal for exactly that due (`learned.acceptedLate`); a changed due date voids it.
- **Deleting a block means "not there".** The task is re-planned elsewhere in that run.
- **Known literal-spec consequence.** Answering No to a "missed due date" question about a brand-new task leaves it unplanned until you edit the task, because "keep as is" means it had no blocks.

## Engine (src/engine)

- **Debounce (E8).** If user edits happened less than 90 s ago, the tick waits without advancing its snapshot, so a burst of drags becomes one re-plan. After 10 min Tempo plans anyway.
- **No self-echo.** The snapshot for the next tick is what Tempo read plus exactly what it wrote, built from the API responses. It is not a re-fetch, because a re-fetch would swallow edits the user made while the tick ran. The debounce compares fingerprints (id + `updated`), not clocks, so Tempo's own writes never count as user edits.
- **Worked time.** Tempo blocks are read back 30 days, so minutes already worked on multi-day tasks are subtracted. Other calendars are read back 24 h.
- **Unaskable questions.** A question that can't be sent (no organizer account, send error, deadline passed) gets full "No" semantics, learning included, so Tempo doesn't hold or re-raise the same proposal every tick.
- **Renamed tasks.** Renaming a Google Task renames its future blocks.
- **Idempotent writes.** Tempo picks event ids itself (base32hex). If a retried insert gets a 409, the earlier attempt succeeded, so there are no duplicate blocks or invitations.
- **Periodic re-plan.** Every 15 min Tempo re-plans even without changes, because time passes and the lock window moves. Most of these runs change nothing.
- **Invitations.**
  - Questions go out as invitations from the separate organizer account (Google requires organizer ≠ attendee).
  - While a question is open, the invitation replaces the affected blocks.
  - Answered invitations are deleted without sending an email.
  - Unanswered ones get a note "No answer … — Tempo kept your plan" (D12).
  - Without a connected organizer account, questions expire immediately. That counts as No, which is the safe default.
- **Change detection.** Polling every 60 s always runs, because Google Tasks has no push notifications. Calendar push via `events.watch` is optional (`TEMPO_WEBHOOK_URL`), needs a public HTTPS URL, and channels are renewed before they expire.

- **Settings file.** `tempo.json` (written by setup) holds working hours per weekday, focus, sleep, buffer and busy calendars. The engine re-reads it every tick (`SettingsStore`) and re-plans on change (signal `settings-changed`). An invalid file keeps the last valid settings and is reported once.
- **Busy calendars.** Initially the calendars shown in Google Calendar's sidebar (`selected && !hidden`), minus holiday/birthday calendars; afterwards `tempo calendars add|remove|reset`. Note: a calendar you hide for visual reasons (e.g. sport) is then not busy time; add it back if it should be.
- **Account switch.** Running setup with another Google account starts from a clean state; `plan`/`run` refuse to run with a different signed-in account.
- **Hidden invitations.** Google accounts that only accept invitations from known senders never show "Tempo asks: …" in the calendar (found live). Setup and status detect `hideInvitationsSetting` and say how to fix it.
- **Reasons per change.** Explanations are keyed per change, so a move and a delete of the same task keep their own text.

## LLM (src/llm)

- **Provider.** Claude (`TEMPO_ANTHROPIC_API_KEY`), Gemini (`GEMINI_API_KEY`), or a deterministic heuristic. The Anthropic client is built explicitly and ignores other tools' `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL`.
- **Validation.** Every model answer is checked with zod. A failure falls back to the heuristic for that call, so the pipeline never sees an LLM exception.
- **Duration limit.** Estimates may be up to 40 h, enough for multi-day work like a thesis chapter.

## Google (src/google)

- **Scopes.**
  - Student account: `calendar`, `tasks.readonly`, `openid email`.
  - Organizer account: `calendar.events.owned`, `openid email`.
- **What Tempo stores in events.**
  - Blocks carry hidden metadata in `extendedProperties.private`: task id, list id, and the start/end Tempo last wrote. A difference from the live times means you dragged or resized the block.
  - Invitations carry `extendedProperties.shared`, which is visible on your copy. That is how Tempo recognises its invitations and never treats them as busy time.
- **Tasks.** Google Tasks due dates are date-only. Tempo reads them as the end of that local day.
- **Testing-mode OAuth.** In Google's "testing" mode, refresh tokens expire after 7 days. When that happens, run `tempo login` again.
