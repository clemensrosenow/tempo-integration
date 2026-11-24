# Tempo – Spec: Design Decisions & Requirements Prioritisation

- Course: User Interface Design (LMU MMT, WS 26/27), Group 3
- Team: Rebeca Gazola, Clemens Rosenow
- Deadline: final presentation + clickable prototype, 02.02.2027
- Status: scope agreed 11.11.2026
- Related: `Tempo – Project Scope.docx/.pdf` (1-page summary), `Tempo Pitch Deck.pdf`, `Lotus Board.pdf`

## Problem Statement

Students know *what* they have to do, but not *when*. Turning tasks into time slots in the calendar is manual work, and the plan breaks as soon as a meeting runs late. Existing AI planners (Reclaim, Motion, Clockwise):

- add yet another app to check every day
- need ~15 min setup before the first plan
- move calendar blocks out of sight, so users lose trust and control

Course requirement: "Beyond chatbots" – AI that works in the background, while users stay aware of its capabilities and limits and can correct it.

## Solution

**Value proposition:** Always know what to do next. Connect your calendar once and it plans itself, no new app to learn.

Tempo plans tasks as time blocks in the calendar the user already uses and repairs the day when plans slip. It has zero new screens: every interaction uses features the calendar already has (events, descriptions, Free/Busy, invitations with Yes/No/Maybe, drag and drop, calendar show/hide). The only own UI is a one-page connect/onboarding page.

Core loop (from pitch deck): **Propose → Decide → Adapt → Learn**. Tempo acts automatically by default and asks only when a decision is critical.

## Requirements Prioritisation

### Essential (prototype must have)

| # | Requirement | Summary |
|---|---|---|
| E1 | One-step start | Connect Google once. Working hours, focus time, sleep and calendar selection pre-filled from the last 4 weeks of calendar history; user only confirms. |
| E2 | Tempo calendar | All task blocks live in a separate "Tempo" calendar; native checkbox shows/hides them. |
| E3 | Task understanding | LLM estimates duration, priority and urgency from Google Task title, notes and due date. |
| E4 | Subtasks | Google Tasks subtasks = atomic work steps of one task, planned in order before the parent due date. |
| E5 | Continuous planning | Re-plans on every relevant change; new tasks planned right away; urgent/important tasks planned the same day. |
| E6 | Quiet repair | Signals: user extends/moves a block; a block ends while its task is not checked off. Tempo adjusts the rest of the plan. |
| E7 | Fixed events | Events Tempo did not create are never moved. Events marked "Free" or declined count as available time. |
| E8 | Stability rules | Minimal change; next 1 hour locked; debounce bursts of changes. |
| E9 | Ask only when it matters | Invitation for: missed due date, dropped task, unclear priority, big change (>3 blocks moved or a block moved >2 days). |
| E10 | Invitation semantics | Yes = apply, No = keep plan (and learn), Maybe = "other time" (next-best option). One open question at a time. No answer 1 h before the slot = No. |
| E11 | Transparency | Every moved block carries a one-line reason in its description. |
| E12 | Learning by doing | Drags and resizes become preferences; block description notes "Tempo learned: …". No extra click. |
| E13 | Multiple calendars | Read all calendars of the account as busy (unless Free); write only to the Tempo calendar. |

### Nice-to-have (only if time allows, in this order)

1. Travel blocks between locations (public transport)
2. Moodle deadlines (LMU SSO, unstructured data)
3. Gmail → tasks
4. Meeting-overrun detection from camera/microphone use (macOS helper; does not cover in-person meetings)
5. Task dependencies inferred by the LLM, only for very confident, logical cases (e.g. groceries before cooking); no user input for dependencies

### Out of Scope

- Chrome extension or any UI injected into calendar.google.com
- Booking / reservations on the user's behalf
- "What Tempo learned" overview screen
- Multiple Google accounts (workaround: share other calendars into the main account)
- Learning which fixed events the user skips (only native Free/declined signals)
- Self-report actions ("Running late" button)
- Mocked calendar UI – the prototype uses a real Google Calendar integration
- Optimisation solver for placement
- Explicit user-defined dependencies (e.g. "after:" syntax)

## Design Decision Log

| # | Topic | Decision | Rationale |
|---|---|---|---|
| D1 | Target audience | Students with a scattered week (lectures, part-time job, group projects, sport, several locations), already using a digital calendar | Makes the repair scenario believable; team can self-test |
| D2 | Hero value | Repair is the hero; Plan is the setup. Approval stays in the background | Auto-planning alone = Reclaim/Motion; repair differentiates |
| D3 | Value proposition wording | Focus on value (clarity, quick start, existing tools), not features; no brand names | Feedback: first draft too focused on "what" |
| D4 | Platform | Desktop build, real Google Calendar + Google Tasks integration; works on mobile via the native calendar apps | No mocking; mobile comes free with native features |
| D5 | Interaction surface | Native calendar features only: Tempo calendar, event descriptions, invitations, drag/resize | Strongest "0 new screens"; robust against UI changes |
| D6 | Repair signals | Essential: block extended/moved; block ended + task open. Camera/mic + location = nice-to-have | API-only, covers in-person meetings; extending a block is an honest user signal, not "auto-detection" |
| D7 | Fixed events | Never moved. Free/declined = plannable | Trust; user rule |
| D8 | Automation level | Maximum automation incl. moving to another day; no notification for automatic moves | "AI in the back" |
| D9 | Invitations | Reserved for critical decisions and key feedback (missed due date, dropped task, unclear priority, >3 blocks or >2 days) | Avoid prompt fatigue |
| D10 | RSVP meaning | Yes = apply; No = keep + learn; Maybe = other time. Labels can't be renamed → meaning explained in the description | Reuse known controls |
| D11 | Edge-case display | Invitation at the proposed slot (also late slots) replaces the affected block while open; No restores it. Max one open question | No clutter, one pattern for all edge cases, no new channel |
| D12 | Unanswered invitation | No answer 1 h before the slot → No (keep plan), note in description | Doing nothing never causes unwanted change |
| D13 | Learning feedback | Silent learning from drags/resizes, visible as a line in the event description | Quick, integrated, zero extra clicks |
| D14 | Missing task fields | AI estimates duration/priority; user corrects by resizing | Real AI value; no syntax to learn |
| D15 | Subtasks vs dependencies | Subtasks = steps within one task; cross-task dependencies only via LLM inference (nice-to-have), stored hidden | Subtasks have no own due date, one level deep |
| D16 | Planning cadence | Continuous planning + immediate planning of urgent tasks | Plans change during the day |
| D17 | Stability | Minimal change, 1 h lock, cap (>3 blocks / >2 days → invite), debounce | Predictability (Lotus board) |
| D18 | Onboarding | One connect page + 3 setup values (working hours, focus time, sleep) + calendar list, all pre-filled from history | Beats the "15 min setup" of competitors; caveat: thin history → weaker first plans |
| D19 | AI architecture | Multi-step LLM pipeline with simple code checks; no solver | Team already built a solver – too hard to tune in time |
| D20 | Why AI | Understands vague tasks; weighs trade-offs; learns without settings; explains itself | Answers "why not just rules?" |

## User Stories

### Onboarding
1. As a student, I want to connect my Google account in one step, so that I get a first plan without a long setup.
2. As a student, I want my working hours, focus time and sleep pre-filled from my calendar history, so that I only confirm instead of typing.
3. As a student, I want to see which calendars Tempo will read, so that I can untick irrelevant ones (e.g. holidays, a partner's shared calendar).
4. As a student with little calendar history, I want reasonable defaults, so that Tempo still works on day one.
5. As a student, I want Tempo to start drafting right after onboarding, so that I see value immediately.

### Planning
6. As a student, I want my Google Tasks to appear as time blocks in my calendar, so that I know when to work on what.
7. As a student, I want Tempo blocks in a separate calendar, so that I can show or hide them with the normal checkbox.
8. As a student, I want Tempo to estimate how long a task takes, so that I don't have to.
9. As a student, I want Tempo to estimate priority and urgency, so that important work is planned first.
10. As a student, I want to fix a wrong duration by resizing the block, so that correcting Tempo feels natural.
11. As a student, I want subtasks planned in their order before the parent's due date, so that big tasks are broken into doable steps.
12. As a student, I want new tasks planned right away, so that my calendar is always up to date.
13. As a student, I want urgent tasks planned on the same day, so that I don't miss deadlines.
14. As a student, I want tasks scheduled within my working hours, so that my evenings and sleep stay free.
15. As a student, I want Tempo to respect my focus-time preferences, so that deep work lands at good times.
16. As a student, I want Tempo to never touch my lectures and meetings, so that I can trust my calendar.
17. As a student, I want events I marked as "Free" or declined to count as available time, so that skipped lectures can be used for work.
18. As a student with several calendars, I want all of them considered as busy, so that Tempo never double-books me.
19. As a student, I want Tempo to write only to its own calendar, so that my other calendars stay clean.

### Repair
20. As a student, I want to extend a meeting block when it runs late, so that Tempo moves the following work automatically.
21. As a student, I want Tempo to notice when a block ends and its task is not checked off, so that the open work is re-planned.
22. As a student, I want only affected blocks to move, so that the rest of my day stays familiar.
23. As a student, I want the next hour never to change, so that I can rely on what I'm about to do.
24. As a student, I want several quick edits to be handled as one change, so that my calendar doesn't flicker while I drag blocks.
25. As a student, I want blocks moved to another day without being asked when nothing critical changes, so that I'm not interrupted.
26. As a student, I want each moved block to state why it moved, so that I understand Tempo's decisions.

### Asking for decisions
27. As a student, I want an invitation when a task would miss its due date, so that I decide on the trade-off.
28. As a student, I want an invitation before Tempo drops a task, so that nothing disappears silently.
29. As a student, I want to be asked when a task's priority is unclear, so that Tempo doesn't guess wrong on important work.
30. As a student, I want to be asked before big changes (more than 3 blocks or more than 2 days), so that my plan doesn't change drastically without me.
31. As a student, I want to answer with Yes, No or Maybe, so that deciding takes one tap.
32. As a student, I want "Maybe" to give me another option, so that I can find a better time.
33. As a student, I want "No" to keep my current plan, so that I stay in control.
34. As a student, I want only one open question at a time, so that I'm never faced with a stack of decisions.
35. As a student, I want the question invitation to replace the affected block, so that my calendar doesn't get cluttered.
36. As a student, I want nothing to change if I don't answer, so that ignoring Tempo is always safe.
37. As a student, I want a clear proposal even when no slot exists before the deadline (e.g. "1 day late"), so that I can decide quickly.
38. As a student, I want invitations to reach my phone through the normal calendar notifications, so that I don't need another app.

### Learning
39. As a student, I want Tempo to learn from my drags and resizes, so that plans fit me better over time.
40. As a student, I want to see what Tempo learned in the moved block, so that learning is transparent.
41. As a student, I want to undo a learned preference by dragging again, so that I can correct Tempo without settings.
42. As a student, I want my "No" answers to teach Tempo, so that it stops proposing similar changes.

### Nice-to-have
43. As a student, I want Moodle deadlines imported as tasks, so that course work is planned automatically.
44. As a student, I want tasks extracted from emails, so that requests don't get lost in my inbox.
45. As a student in online meetings, I want overruns detected from camera/microphone use, so that I don't have to extend the block.
46. As a student moving between campus, library and gym, I want travel blocks between locations, so that my plan is realistic.
47. As a student, I want obvious task order inferred (groceries before cooking), so that dependent tasks are planned correctly.

### Course / evaluation
48. As a course examiner, I want to see AI acting in the background with visible reasons and easy correction, so that I can assess transparency and control.
49. As a course examiner, I want design decisions linked to lecture concepts (Horvitz 1999, Amershi et al. 2019, Shneiderman 2020), so that I can grade the reflection.

## Implementation Decisions

### Modules
- **Connect & onboarding page** – Google OAuth, calendar list, pre-filled setup values (working hours, focus time, sleep) inferred from the last 4 weeks.
- **Google adapter** – reads calendars (Free/Busy, RSVP status, attendees), Google Tasks (title, notes, due date, status, subtasks); writes events to the Tempo calendar; sends invitations from the Tempo organizer account; reads RSVP responses.
- **Change detection** – Calendar push notifications (webhooks) plus sync tokens; Google Tasks has no push notifications, so tasks are polled. Debounces bursts into one re-plan.
- **Planning pipeline** (core module, see below).
- **Decision rules** – auto vs. invitation, lock window, cap, one-open-question queue, timeout = No.
- **Preference store** – learned preferences from drags/resizes/RSVP answers.
- **Storage** – small backend DB for OAuth tokens, webhook channels, preferences, open question queue. Per-block data (task id, estimates, reason, dependency hints) stored in hidden event extended properties.

### Planning pipeline (LLM multi-step, no solver)
1. **Understand** (LLM, per task) → structured JSON: duration, priority, urgency, confidence.
2. **Find gaps** (code) → free slots from all selected calendars; fixed events blocked; Free/declined = free; next 1 h locked.
3. **Place** (LLM) → assign tasks to gaps using preferences; minimal-change instruction.
4. **Check** (code) → no overlap with fixed events, before due date, inside working hours, subtasks in order; on failure feed errors back to the LLM (max 2 retries).
5. **Decide** (code) → auto-apply vs. invitation (rules below).
6. **Explain** (LLM) → one-line reason per moved block.

### Decision rules
- Auto-apply: any move of Tempo blocks, also to another day, if no rule below fires.
- Invitation if: due date missed; task dropped; priority confidence low; >3 blocks moved; any block moved >2 days.
- Never: move non-Tempo events; change anything starting within the next hour.
- One open question at a time; others queued.
- No answer 1 h before the proposed slot → No.

### Interaction contract (native calendar features)
- Tempo blocks: events in the Tempo calendar; title = task title; description = reason + "Tempo learned: …" lines.
- Questions: invitations from the Tempo organizer account, title "Tempo asks: …", placed at the proposed slot, replacing the affected block while open. Description explains "Yes = apply · No = keep as is · Maybe = other time". Invitations land in the primary calendar (Google behaviour).
- Done signal: checking off the Google Task.
- Feedback: drag/resize of a Tempo block.

### Technical notes
- A Google invitation needs an organizer different from the attendee → separate Tempo Google account.
- RSVP labels (Yes/No/Maybe) are fixed by Google.
- Google Tasks: due date only (no time), no custom fields, one subtask level.
- OAuth app can stay in Google "testing" mode for the course (limited test users), so no verification is needed for the prototype.

## Testing Decisions

- Good tests check external behaviour only: given a calendar + tasks + preferences + a change signal, what does the calendar look like afterwards and which questions are sent. No assertions on prompts or internal steps.
- **Proposed seam (one, as high as possible):** the planning pipeline + decision rules as one unit: input = calendar snapshot, task list, preferences, signal, current time; output = list of event changes, questions, reasons. Google is replaced by an in-memory fake adapter; the LLM is replaced by a stub with fixed answers for deterministic tests.
- Key test cases: meeting overrun → following blocks move, next hour untouched; block ends with open task → re-planned; fixed event never moved; Free/declined event used; due date missed → exactly one invitation; >3 blocks or >2 days → invitation; second question queued; no answer → No; Maybe → next-best option; resize → duration preference stored; subtasks stay in order.
- LLM quality (estimates, placement, reasons) evaluated separately with a small fixed set of example tasks, not in unit tests.
- Usability: test the prototype with fellow students on the hero scenario (meeting runs 45 min over) and an edge case (task can't fit before its due date).
- Prior art: none – no codebase exists yet.

## Further Notes

- Presentation must reflect lecture concepts: mixed-initiative (Horvitz 1999), guidelines for human-AI interaction (Amershi et al. 2019), human-centered AI (Shneiderman 2020); Lotus board themes: risk-based permissions, reversibility, predictability, attention-aware timing.
- Risks: camera/mic detection misses in-person meetings; thin calendar history weakens onboarding defaults; continuous planning can feel unstable if debounce/lock are tuned wrong; LLM placement may need several retries.
- The 1-page summary (`Tempo – Project Scope.pdf`) is the submitted version; this spec is the working reference.
