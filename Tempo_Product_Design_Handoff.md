# Tempo Product Design Handoff

*Notion and Notion Calendar integration*

Product, design, and engineering / 24 November 2026

Tempo turns an existing Notion task list into work sessions in Notion Calendar and repairs the smallest part of the schedule it can when plans change. The user keeps adding and completing tasks in Notion. The calendar shows what to work on next, and native calendar edits can correct the plan.

## Who the first release serves

Start with an individual who already uses an actionable personal task database and Notion Calendar. The commercial pilot targets independent consultants and freelancers with changing client calendars. Students with a similar setup can test the same interaction model with lectures, shifts, and assignment deadlines.

## Where each interaction belongs

| Surface | What the user does there |
| --- | --- |
| Existing Notion task database | Capture work, set its deadline or priority if known, and mark the original task complete. |
| Notion Calendar | See Tempo Sessions alongside commitments. Open the next session, move or adjust it on desktop or web, and inspect why it moved. |
| Tempo page in Notion | Review unscheduled work and the most urgent exception, view recent changes, and open the original task from a session. |
| Tempo setup page | Connect accounts, choose availability and working hours, approve the first plan, and manage pause or reconnect. |

## What makes the experience worth keeping

**Start quickly.** Preserve the user’s database and infer reasonable values from the fields they already maintain.

**Keep the plan stable.** Place new work in available gaps first. Favor a small repair when something changes.

**Make control obvious.** A correction sticks. A deadline trade-off asks for a decision. The normal day requires no routine review.

Design baseline: one person, one task database, one Notion workspace, and selected Google calendars for live availability. The schedule is displayed in Notion Calendar. Google access is read-only.

## First Run and Activation

The first usable plan should appear within five minutes for most people in the pilot. Time the full flow from signup through the point at which the user sees their sessions in Notion Calendar.

| Step | Screen and user action | Result and recovery |
| --- | --- | --- |
| 1 Connect Notion | Choose a task database and an editable private page for Tempo Sessions. Confirm the workspace. | Show the workspace and database names before proceeding. If the database is missing, return the user to Notion’s access picker with their setup intact. |
| 2 Check task selection | Confirm the completion rule from sample tasks. Map a due date, duration, or priority only if it is useful and available. | Preview three real rows. Exclude completed and explicitly parked tasks. Ask for a completion rule only if unclear. Remember the mapping by field ID. |
| 3 Connect availability | Connect Google, select the calendars that contain real commitments, and confirm working hours and time zone. | Explain that Tempo reads busy intervals. Show selected calendar names and ask the user to check they match what matters in Notion Calendar. |
| 4 Preview and start | Review today and tomorrow, then select Start planning. Show estimated durations, sample blocks, and work that could not fit. | Preview writes nothing. Create the Sessions database only after confirmation. Treat retries as a continuation of the same activation. |
| 5 Show in Notion Calendar | From the Tempo Sessions database, select Open in Calendar. Alternatively, add the database from the Notion Calendar sidebar on desktop or web. | Use Scheduled time as its primary date. Show a named sample session and ask the user to confirm they can see it. Pause rolling automation until this step is confirmed. |

### Activation states

**Nothing to plan yet.** Show the selected database and explain exactly what makes a task eligible. Link to the existing task list. Keep progress and resume as soon as an eligible task appears.

**Availability is missing.** Let the user see an explicitly labeled working-hours preview. Gate live, conflict-aware scheduling on a successful availability connection.

**Calendar still looks empty.** Check whether Notion Calendar is linked to the same Notion workspace and whether Tempo Sessions is visible. Keep the setup link and sample session available. Native database setup requires desktop or web. \[1, 2\]

Suggested copy: “Choose the calendars Tempo should plan around. Tempo shows your work sessions in Notion Calendar.”

## The Everyday Workflow

### Capture and choose the next task

The user adds “Review client proposal” in their current Notion database. Tempo picks up the eligible task, uses a duration already supplied or estimates one, and places it in an open window. Notion Calendar shows the normal task title. The user can see the next session at a glance and open it for context.

| Session detail | Example | Purpose |
| --- | --- | --- |
| Title and time | Review client proposal • 10:00 to 10:45 | Identify the work and the time commitment. |
| Original task | Open task in Notion | Reach the source page to read context or mark work complete. |
| Why this time | Placed before your 13:00 deadline. | Explain the choice in one sentence using facts the user recognizes. |
| Estimate and control | 45 min estimated • Flexible | Show which value is a guess and whether Tempo may move the slot. |
| Change reason when moved | Moved from 10:00 because that time became busy. | Make the repair legible while keeping the calendar title short. |

### Correct a session in place

**Move it.** Dragging a session to a new time pins that session. If the chosen slot conflicts, preserve the user’s edit and surface the conflict for review. A Flexible setting hands placement back to Tempo.

**Change the length.** An end-only date change updates that session’s duration. Tempo retains the start during the current repair and respects the prior pin state on later repairs. An edit that changes the start pins the new placement.

**Finish the work.** Mark the task complete in the original database. Tempo clears its remaining future sessions and keeps past session history. The user can correct a mistaken completion in Notion and let Tempo plan the open task again.

**Leave a session behind.** Use Skip this session in the session details. Tempo clears that slot, suppresses immediate replacement, and shows the still-open task in Needs attention with a Resume option. Hiding the calendar layer is a display choice. Pause controls automation.

### Desktop and mobile

Desktop and web are the primary editing surfaces. Notion Calendar documents dragging and editing a connected database item’s date and time. Use the event detail editor wherever resize handles are unavailable. On mobile, support the task and session page in Notion as the reliable edit path, and test calendar visibility and links on both iOS and Android. \[1–3\]

## Planning and Repair Rules

### How Tempo chooses work

Use the user’s explicit duration, due date, and priority first. Treat a date-only deadline as the end of the last allowed work window on that date in the user’s time zone. Treat timed deadlines as hard cutoffs for automatic placement. For missing duration, estimate from the title and permitted task properties, show that it is estimated, and give the user a quick correction path. For ambiguous tasks, use a neutral importance default. Ask only when the uncertainty changes a real scheduling decision.

Plan a rolling seven-day horizon as an initial default. Give deadline-sensitive work precedence, then use explicit priority and available time to select the rest. Leave a small buffer and keep unplaced tasks in view. Start with one session per typical task. Split longer work into separate sessions only when the task is suitable for splitting and there is a meaningful minimum session length.

### Repair sequence

| Priority | Rule | User-visible result |
| --- | --- | --- |
| 1 Respect constraints | Account for busy intervals, working hours, deadlines, and pinned sessions. Treat the next 60 minutes as protected from optional moves. | Commitments stay reliable. A newly impossible flexible block may move inside that hour to resolve the conflict. |
| 2 Make the smallest repair | Try an open gap for the affected session. Reconsider additional movable sessions only when necessary. Prefer same-day repair if it fits. | Unrelated sessions retain their times. Each moved session gets one reason. |
| 3 Escalate material changes | Ask before a late placement, a displacement of more than three existing blocks, a move of more than two calendar days, or any move of a pin. | Show the proposed change and consequence. Remove a now-conflicting flexible slot from the active grid if there is no safe automatic placement, and list it in Needs attention. |
| 4 Protect against noisy signals | Debounce edits and recheck availability before publishing. An expired session with an open task is an ambiguous signal. | Keep the past slot as history. Keep any already planned time for the task. If none remains, ask whether more time is needed. An open status alone does not imply the entire estimate remains. |

### What counts as a calendar change

A meeting extension triggers repair once the connected provider reflects the new busy interval. Tempo sees the calendar change, not the meeting itself. A changing calendar with an expired connection becomes a reconnect state. The last displayed plan remains available with a stale status and scheduling writes pause until availability is current.

The thresholds above are pilot defaults. Track unnecessary moves, deadline risk, and how often a user has to answer an exception before tuning them.

## An Exception and Its Resolution

### The same day before and after

Alex has a client review due at 13:00 and a routine admin task. At 09:50 the kickoff is extended to 10:45. The only open 45-minute slot before the deadline starts at 11:30. Lunch and other commitments fill the rest of the window.

| Item | Before | After and reason |
| --- | --- | --- |
| Client kickoff | 09:30–10:00 | 09:30–10:45. The organizer extended it. |
| Review client proposal | 10:00–10:45 | 11:30–12:15. Only this session moves. It still fits before 13:00. |
| Process invoices | 11:00–11:30 | 11:00–11:30. It is unaffected by the kickoff. |

If another meeting fills 11:30–12:15 and there are no other 45-minute openings before 13:00, Tempo shows one decision in Notion. It preserves any viable plan while review is pending. An impossible flexible slot is removed from the active grid and remains visible as work needing attention.

### Decision details and copy

**Headline.** “Client proposal is at risk.”

**Why it surfaced.** “Your morning changed. There’s no 45-minute opening before 13:00. The next available time is 13:30–14:15.”

| Action | Outcome |
| --- | --- |
| Use 13:30 | Recheck availability and publish only if the proposal is still valid. Keep the original deadline and show that the session is after it. |
| Find another time | Show the next viable option if one exists. If there is none, say so and keep the review item actionable. |
| Leave unscheduled | Preserve the original task and record that the user will schedule it later. Resume is available from Needs attention. |

### Review visibility and timing

Show one actionable decision first, ordered by the time at which the user would lose the best option. Keep the other work visible as a count in Needs attention. Where a valid related session remains in the grid, show Needs review in its details and link to the decision. Expose review actions as clearly named options in an editable Notion Select field. Keep the review row undated so it does not occupy a calendar slot. Opening the Tempo page in Notion is the fallback when a client cannot expose a control in the calendar.

On silence, let the suggestion expire before the slot starts and apply no late placement. Keep the task visible with its deadline and refresh the proposed option when the user returns. Test whether people discover urgent reviews in this flow. A single opt-in alert for time-critical exceptions is a candidate if discovery proves too weak.

Undo a recent Tempo repair from Recent changes while the previous placement is still feasible. If it has become impossible, explain the conflict and offer the next valid placement.

## Integration and Data Ownership

Create a Tempo Sessions database in the user’s selected private Notion page. Limit source access to what the user selects in Notion’s authorization picker. \[9\] Each work session is a Notion page dated by a writable Scheduled time range. The user adds that database to Notion Calendar once. Editing the calendar item updates the Notion record, which Tempo can reconcile through Notion webhooks. A session can represent one part of a task without changing its deadline or adding fields to the source database. \[1–5\]

| Record or field | Owner | Contract |
| --- | --- | --- |
| Task title and completion | User in Notion | Read from the selected data source. Only open, eligible tasks are planned. Require an unambiguous done rule before activation. |
| Deadline, priority, duration | User in Notion | Read mapped properties if supplied. Store estimates separately from user-authored values. An explicit value takes precedence. |
| Scheduled time | Tempo and user | Writable Date with start and end. Use it as the calendar date. A human edit supersedes a pending automatic write. |
| Source task and reason | Tempo | A direct link to the original task and one short reason on the session page. Refresh the visible label when the task title changes. |
| Control and review | Tempo and user | Use Select fields supported by the client or edit on the Notion page. Validate any requested action against current state before applying. |
| Calendar commitments | Calendar provider | Read selected Google calendars’ busy intervals. Tempo publishes work sessions into Notion and treats commitments as external constraints. |

### Platform boundaries

**Notion Calendar is the work surface.** Its documented local API opens an event on desktop. The live scheduling design uses Notion as the write surface and Google FreeBusy to read availability. Automatic conflict detection covers the selected Google calendars. \[4, 6, 7\]

**Visibility and availability are distinct.** A Tempo session is a Notion database item. It appears in Notion Calendar and does not create a busy event on the underlying Google calendar. This release offers a personal plan. Booking protection or publishing to external calendars would require a separate, consented design. \[1, 7\]

**Sync should be safe to repeat.** Associate one stable ID with each task and planned session. Read the latest record before applying changes, deduplicate deliveries, avoid treating Tempo’s own writes as edits, and recover from interrupted updates. Keep only the calendar intervals needed to plan and label generic reasons without exposing meeting details. \[5, 7, 8\]

## Recovery and Product Boundaries

| State | What the user sees | System behavior |
| --- | --- | --- |
| Connected but hidden | “Tempo Sessions is ready. Turn it on in your Notion Calendar sidebar.” | Keep the displayed plan current after activation. Let the user distinguish hiding the database from pausing their plan. |
| Database fields changed | “Tempo needs to check how you mark a task done.” | Pause the affected task intake. Resume after the user confirms a new mapping and sees representative tasks. |
| Availability is stale | “Calendar availability is out of date. Reconnect Google to repair your plan.” | Preserve the last published blocks. Resume from a fresh availability snapshot and compare changes with the last visible plan. |
| Task or session removed | Show removed or skipped work in the appropriate Notion view with recovery actions where possible. | Archive of a source task clears its future sessions. Manual archive of a session sets it to skipped and requires a resume decision before replacing it. |
| Editing or writing failed | Show the last successful update, which part needs attention, and a retry action. | Recover using session IDs. Reconcile partial writes before retrying, and keep the original task available. |
| Automation paused | “Planning is paused. Your existing sessions are still visible.” | Stop new writes. Offer Resume with a plan review. Temporary hides in Notion Calendar are independent of pause. |
| Disconnect | Offer to keep or clear upcoming Tempo sessions while write access is still available. Explain any manual cleanup if permission was revoked first. | Respect the selected cleanup, revoke the connection, and clear retained access according to the deletion policy. |

### Release boundary

The first release covers one existing task database, the Sessions layer, work hours and Google availability, initial approval, background scheduling, safe repairs, and a Notion review flow. Keep the original source database the authority for task status. Prefer an editable native property over a custom button where both achieve the same result.

Defer additional availability providers, multiple task databases, automatic meeting attendance detection, team assignment, and publishing real busy events. These expand the permissions model or the number of places users must understand before the core workflow is proven.

### Accessibility and visibility

Give every state a readable text label in addition to any color. Use descriptive links such as Open original task and Review deadline. Ensure the session details, review queue, and fallback forms work with a keyboard. Use local time consistently and display the time zone when it differs from the selected planning zone.

## Acceptance and Prototype Checklist

| Scenario | Pass condition |
| --- | --- |
| Existing database and first plan | The test user connects an existing task list without changing the schema, recognizes the eligible sample tasks, approves the preview, and finds the named session in Notion Calendar. |
| A late meeting and an overloaded day | A newly conflicting flexible session moves to a feasible gap. Unaffected slots remain stable. An impossible deadline surfaces one meaningful choice and preserves the original task. |
| Drag, resize, and finish | Manual time edits persist through later sync. A pin remains pinned. Completed tasks lose only their future sessions. A past open task does not automatically repeat its original duration. |
| Retry, stale data, and resume | Duplicate webhook delivery, expired availability access, or a partial write produces no duplicate session. Pause and reconnect leave the user with a clear next action. |
| Platform and account variations | Confirm real desktop and web behavior for primary date, dragging, date-range editing, and Select. Check iOS and Android visibility, source links, and Notion fallback. Verify OAuth, permissions, and working-hours time zones. |

### Success measures

Measure signup to first visible session, share of setups completed without help, first-plan blocks corrected, manual corrections per active week, unaffected blocks moved per disruption, and deadline-risk discovery. In the pilot, compare the same tasks and disruptions against each user’s current workflow. Observe whether they voluntarily leave automation enabled after two weeks.

### Platform references

\[1\] [Notion Help • Use Notion Calendar with Notion](https://www.notion.com/help/use-notion-calendar-with-notion)

\[2\] [Notion Help • Getting started with Notion Calendar](https://www.notion.com/help/guides/getting-started-with-notion-calendar)

\[3\] [Notion Help • Notion Calendar desktop and mobile apps](https://www.notion.com/help/notion-calendar-apps)

\[4\] [Notion Help • Notion Calendar connections and API](https://www.notion.com/help/notion-calendar-connections)

\[5\] [Notion Developers • Webhooks](https://developers.notion.com/reference/webhooks)

\[6\] [Notion Developers • Create a database](https://developers.notion.com/reference/create-a-database)

\[7\] [Google Developers • Calendar FreeBusy query](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query)

\[8\] [Google Developers • Choose Calendar API scopes](https://developers.google.com/workspace/calendar/api/auth)

\[9\] [Notion Developers • Public integration permissions](https://developers.notion.com/guides/connections-and-tokens/overview)

Product inputs: Tempo project scope and November 2026 working specification. The workflow above adapts their calendar-first planning and repair behavior to Notion.
