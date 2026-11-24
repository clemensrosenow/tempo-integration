# Tempo — calendar integration (headless)

Use the [Notion Calendar setup guide](docs/notion-setup.md) for the Notion task integration and the `tempo-notion` command.

Tempo plans your Google Tasks as time blocks in a separate **"Tempo" calendar**
inside the Google Calendar you already use, and quietly repairs the plan when
your day slips. There is no UI: every interaction happens through native
Google Calendar features (events, descriptions, invitations with Yes/No/Maybe,
drag & resize, the calendar show/hide checkbox). This repository is the
working integration behind the spec in [`docs/tempo-spec.md`](docs/tempo-spec.md).

Sign-in, calendar reading/writing, invitations and task fetching go **only
through Google** (OAuth 2.0, Google Calendar API, Google Tasks API).

## How it works

```
Google Tasks ─┐                                 ┌─► Tempo calendar (blocks + reasons)
              ├─► detect signals ─► pipeline ───┤
Google Cal ───┘   (diff, RSVPs,     Understand  └─► invitation from the Tempo
                   timeouts,        Find gaps        organizer account ("Tempo asks: …")
                   debounce)        Place
                                    Check (≤2 retries → greedy fallback)
                                    Decide (auto vs. ask)
                                    Explain
```

| Spec | Where |
|---|---|
| E1 one-step start | `tempo login` + `tempo setup` (`src/engine/setup.ts`, `src/onboarding/infer.ts`) |
| E2/E13 Tempo calendar, read all / write one | `src/google/calendarAdapter.ts` |
| E3 task understanding | `src/llm/*` (Claude, Gemini or heuristic fallback) |
| E4 subtasks | Google Tasks `parent`/`position` → `src/core` placement order |
| E5 continuous planning | `tempo run` (`src/engine/daemon.ts`): polling + optional Calendar push |
| E6 quiet repair, E7 fixed events, E8 stability | `src/core/signals.ts`, `gaps.ts`, `diff.ts`, engine debounce |
| E9/E10 ask only when it matters, RSVP semantics | `src/core/decide.ts`, `questions.ts`, `src/google/inviteAdapter.ts` |
| E11 transparency | reason line in each block's description |
| E12 learning by doing | `src/core/learning.ts` ("Tempo learned: …" lines) |

## Setup

Requirements: Node ≥ 22, a Google account (the student), and a second Google
account that acts as the **Tempo organizer** (Google only sends invitations
from an organizer different from the attendee).

1. Create the Google Cloud OAuth client — see [`docs/google-setup.md`](docs/google-setup.md).
2. Install and configure:
   ```bash
   npm install
   cp .env.example .env   # optional: LLM key, data dir, horizon
   ```
3. Connect both accounts and onboard:
   ```bash
   npm run tempo -- login                # student account
   npm run tempo -- login --organizer    # Tempo organizer account
   npm run tempo -- setup                # shows inferred hours/focus/sleep/calendars, confirm with Enter
   ```
4. Keep it running:
   ```bash
   npm run tempo -- run
   ```

Other commands: `plan [--force]`, `status`, `tasks`, `prefs`, `calendars`, `clear-blocks`, `logout [--organizer]`.

### Settings: working hours and busy calendars

`tempo setup` writes [`tempo.json`](tempo.example.json) (git-ignored). It is the place to change your
working hours, focus time, sleep, buffer and which calendars count as busy, at any time. A running
Tempo re-reads it on every check and re-plans when something changed; no restart, no new setup.

```bash
npm run tempo -- prefs                              # show
npm run tempo -- prefs hours mon-thu 09:00-20:00    # per weekday; "off" for free days
npm run tempo -- prefs hours fri 09:00-14:00
npm run tempo -- prefs focus 15:00-18:00
npm run tempo -- prefs sleep 23:30-07:00
npm run tempo -- prefs buffer 10
npm run tempo -- calendars                          # which calendars count as busy
npm run tempo -- calendars remove "Sport"
npm run tempo -- calendars add "Uni"
npm run tempo -- calendars reset                    # = the calendars checked in Google Calendar's sidebar
```

Initially, the busy calendars are exactly the ones you show (checkbox ticked) in Google Calendar's
sidebar; holiday and birthday calendars are skipped. Editing `tempo.json` by hand works too; an
invalid file is reported once and the last valid settings stay in use.

### LLM

The pipeline's Understand/Place/Explain steps use an LLM when a key is set
(`TEMPO_ANTHROPIC_API_KEY` for Claude, or `GEMINI_API_KEY` for Gemini; force
with `TEMPO_LLM=anthropic|gemini|heuristic`). Without a key Tempo runs on a
deterministic heuristic + greedy placer, so the integration always works.
Every LLM answer is schema-validated and checked by code; invalid answers fall
back to the deterministic path.

## Using it (the interaction contract)

- **Plan:** add a Google Task (with an optional due date, subtasks for steps) → a block appears in the Tempo calendar.
- **Done:** check off the task → its future blocks disappear.
- **Running late:** extend the meeting in your calendar → following blocks move; the next hour stays as is.
- **Correct Tempo:** drag or resize a block → it stays where you put it and the description says what Tempo learned.
- **Decisions:** for missed due dates, dropped tasks, unclear priority or big changes (>3 blocks / >2 days) you get an invitation "Tempo asks: …" at the proposed slot. Yes = apply · No = keep as is · Maybe = other time. No answer 1 h before the slot = No.

## Trying it live (sandbox)

For experiments, use a separate **test** Google account (sign Tempo in with it via `tempo login`):

```bash
npm run sandbox -- login        # same test account, grants write access for sample data
npm run sandbox -- seed         # a realistic student week: lectures, job, hidden "Sport" calendar, 12 tasks
npm run tempo -- setup --yes
TEMPO_POLL_INTERVAL_SEC=20 TEMPO_DEBOUNCE_MS=30000 npm run tempo -- run   # faster loop for experiments
npm run sandbox -- act help     # extend a meeting, drag/resize/delete blocks, complete/add/edit tasks, RSVP …
npm run sandbox -- blocks       # Tempo blocks with their reason line
npm run sandbox -- reset        # remove all sample data and the Tempo calendar
```

## Development

```bash
npm test          # vitest: core pipeline, Google mapping/adapters (mocked), LLM, onboarding, engine e2e
npm run typecheck
npm run build     # → dist/, `node dist/cli.js`
```

Tests replace Google with in-memory fakes and the LLM with stubs (spec
"Testing Decisions"); no network is used. `test/integration/` runs the real
Google adapters against a stateful simulator of the Calendar/Tasks REST API
(two accounts, invitation copies, RSVPs) together with the real engine.

See [`docs/decisions.md`](docs/decisions.md) for how open points of the spec
were decided, and [`docs/google-api-notes.md`](docs/google-api-notes.md) for
the verified Google API behaviour this relies on. Runtime state (OAuth tokens,
preferences, question queue) lives in `.tempo/` (git-ignored).
