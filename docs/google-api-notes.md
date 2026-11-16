# Google API notes for Tempo

Facts checked against the official docs (November 2026). Each section lists the source and what
Tempo does with it (in `src/google/`).

## OAuth 2.0 for desktop apps

Source: <https://developers.google.com/identity/protocols/oauth2/native-app>, <https://developers.google.com/identity/protocols/oauth2>

- Desktop clients use a **loopback redirect**: `http://127.0.0.1:<port>` (or `[::1]`). Any free port
  works; the app must run a local web server to receive the code. The copy/paste OOB flow is
  **no longer supported**.
- **PKCE is required** for desktop apps; use `S256` (the challenge is base64url(SHA-256(verifier))).
- Desktop apps are *public clients*: the `client_secret` in the downloaded JSON is not
  confidential. Google still accepts and sends it.
- Docs say refresh tokens are always returned for installed apps. Tempo still sends
  `access_type=offline` and `prompt=consent` so a refresh token comes back every time, including when
  the user signs in again.
- Revocation goes to `https://oauth2.googleapis.com/revoke`. It **removes all scopes previously
  granted to the project** for that account, so other tokens for the same account stop working too.
- Refresh token limits: 100 per Google Account per client ID (older ones are invalidated), and a
  token expires after 6 months unused.
- **Testing mode:** "A Google Cloud Platform project with an OAuth consent screen configured for an
  external user type and a publishing status of 'Testing' is issued a refresh token expiring in
  7 days", unless the only scopes requested are name, email and profile. Tempo asks for
  Calendar and Tasks scopes, so **both Tempo logins expire after 7 days** and Google returns
  `invalid_grant`. Fix: run `tempo login` again. `isInvalidGrant()` in `auth.ts` detects this case.
- Testing mode allows at most **100 test users**. Every test user sees an "unverified app"
  warning. (<https://support.google.com/cloud/answer/15549945>, <https://developers.google.com/identity/protocols/oauth2/production-readiness/overview>)
- Granular consent: users can untick individual scopes on the consent screen. `signIn()` compares the
  granted `scope` with the scopes Tempo needs and stops with a clear error if any are missing.

Implementation: `src/google/auth.ts` uses `OAuth2Client.generateCodeVerifierAsync()`, `generateAuthUrl({
access_type:'offline', prompt:'consent', code_challenge_method:S256, state })`, a one-shot loopback
server (state-checked), `getToken({code, codeVerifier})`, and the email from the `id_token`, falling back
to the OIDC userinfo endpoint. Tokens are saved to `<dataDir>/tokens/<profile>.json` (0600).
Refreshed access tokens are saved through the client's `tokens` event, and the old
`refresh_token` is kept because refresh responses leave it out.

## Scopes

Source: <https://developers.google.com/workspace/calendar/api/auth>, method reference pages.

| Profile | Scopes | Why |
|---|---|---|
| user | `openid email calendar tasks.readonly` | Read every calendar + create the Tempo secondary calendar and write events in it; read Google Tasks. |
| organizer | `openid email calendar.events.owned` | `events.insert/get/patch/delete` all accept `calendar.events.owned` ("manage events on calendars you own"). The organizer only touches its own primary calendar, so this is the narrowest scope that works. `calendar.events` would also work. |

A narrower option for `user`: `calendar.readonly` + `calendar.app.created`. `app.created` covers
`calendars.insert`, `calendarList.patch` and events in calendars the app created. It would enforce
E13 ("write only to the Tempo calendar") at the permission level. Tempo does not use it yet because
the spec chose `calendar`.

`tasks.readonly` is enough because Tempo never writes tasks. Checking a task off is the user's own action.

## events.list, singleEvents, sync tokens, 410

Sources: <https://developers.google.com/workspace/calendar/api/v3/reference/events/list>, <https://developers.google.com/workspace/calendar/api/guides/sync>

- `singleEvents=true` expands recurring events into instances. `orderBy=startTime` works only with
  `singleEvents=true`. `maxResults` defaults to 250, max 2500. `timeMin`/`timeMax` must be RFC 3339 with
  an offset (`Date.toISOString()` is fine).
- `syncToken` **cannot be combined with** `iCalUID, orderBy, privateExtendedProperty, q,
  sharedExtendedProperty, timeMin, timeMax, updatedMin`. With a sync token, **deleted events are always
  included**, as `status: 'cancelled'` with only id + status for tombstones.
- The guide says to use the same query parameters on every request. For the first full sync it allows
  limiting the date range. Tempo's full sync sends `singleEvents=true` + `timeMin = now - 7 days` (no
  `orderBy`). The incremental sync sends `singleEvents=true` + `syncToken`.
- `nextSyncToken` is **only on the last page**. Tempo saves it only after all pages are read.
- An expired or invalid token returns **410 GONE**: "wipe the store and re-sync". Tempo clears the
  token, runs a full sync and returns `fullResync: true`.
- Tempo's `listEvents` for planning uses `timeMin/timeMax + singleEvents + orderBy=startTime +
  showDeleted=false` and skips calendars that fail with 403/404 (for example an unsubscribed or
  freeBusy-only calendar).

## Event fields Tempo relies on

Source: <https://developers.google.com/workspace/calendar/api/v3/reference/events>

- `start.date` (all-day, `yyyy-mm-dd`) vs `start.dateTime` (RFC 3339). The end is **exclusive**.
  Tempo reads all-day dates as local midnight in the event's or calendar's time zone (`events.list`
  returns the calendar `timeZone`).
- `transparency`: `opaque` = Busy (default), `transparent` = Free. Free events count as available time (E7).
- `attendees[].self` is "Whether this entry represents the calendar on which this copy of the event
  appears" (read-only). Tempo uses that entry's `responseStatus`
  (`needsAction|declined|tentative|accepted`) as `selfResponse`.
- `status`: `confirmed|tentative|cancelled`.
- `guestsCanInviteOthers` and `guestsCanSeeOtherGuests` default to **true**, `guestsCanModify` to false. Invitations set all three to false.
- `reminders` are per calendar copy: the organizer's settings do not change the attendee's reminders.
  The attendee keeps their own calendar defaults, so the 10-minute popup Tempo sets on invitations only
  applies to the organizer's copy. Blocks use `useDefault:false, overrides:[]` (no reminders).

## Extended properties

Source: <https://developers.google.com/workspace/calendar/api/guides/extended-properties>

- **private**: "set on one attendee's local 'copy' of the event". They are tied to the calendarId +
  eventId and are not visible to others.
- **shared**: "visible and editable by all attendees of an event". They are returned no matter which
  calendarId is used, so **shared props are visible on the attendee copy** in the user's primary
  calendar. Only the organizer can change shared props (403 `forbiddenForNonOrganizer`).
- Limits: key ≤ 44 chars (longer keys are dropped silently), value ≤ 1024 chars (longer values are
  cut silently), ≤ 300 props and 32 kB per event.
- Tempo blocks: private `tempo=1, tempoKind, tempoTaskId, tempoTaskListId, tempoPlannedStart,
  tempoPlannedEnd[, tempoPart]`.
  Invitations: shared `tempoQuestionId, tempoTaskId, tempoTaskListId` plus the private set on the
  organizer copy. As a fallback, events whose title starts with `"Tempo asks: "` and that the user did
  not organise are treated as questions.

## sendUpdates

Sources: <https://developers.google.com/workspace/calendar/api/v3/reference/events/insert>, [patch](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch), [delete](https://developers.google.com/workspace/calendar/api/v3/reference/events/delete), <https://developers.google.com/workspace/calendar/api/concepts/inviting-attendees-to-events>

- `all` emails every guest. `externalOnly` emails only non-Google-Calendar guests. `none` sends no
  emails. The docs warn that `none` may stop events from syncing to **external** (non-Google) calendars.
- "When this information is updated on the organizer calendar, the changes are propagated to attendee
  copies". The only change that flows from an attendee back to the organizer is their response status.
- Tempo's choices:
  - Blocks (`insert/patch/delete` in the Tempo calendar): `none`. They have no attendees.
  - `sendQuestion`: `all`. The user must get the invitation, also as a phone notification.
  - `annotate` (description patch): `none`. The Google Calendar attendee copy updates through
    propagation, with no "Updated invitation" email.
  - `cancel`: `all` (as in the port contract). The docs do not say whether a `none` delete reliably
    removes the attendee copy, so Tempo uses `all`, which does. The cost is a cancellation email. It
    can be changed with `new GoogleInviteAdapter(client, { cancelSendUpdates: 'none' })`.
- Patch costs 3 quota units. Arrays in a patch body **replace** existing arrays.
  `updateBlock` sends the whole merged private property map.

## calendars.insert / calendarList

Sources: <https://developers.google.com/workspace/calendar/api/v3/reference/calendars/insert>, <https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/patch>

- `calendars.insert` only requires `summary`. Tempo also sets `description` (which includes the
  marker `[tempo-calendar]`, because calendars have no extended properties) and `timeZone`.
  Scopes: `calendar`, `calendar.app.created` or `calendar.calendars`.
- `calendarList.patch?colorRgbFormat=true` with `backgroundColor/foregroundColor` sets a custom RGB
  colour; `colorId` is then picked automatically. If the new calendar is not in the list yet (404),
  Tempo calls `calendarList.insert` instead.
- Tempo finds its calendar by the description marker (owner role), then falls back to an owned,
  non-primary calendar named exactly "Tempo".

## Push notifications (events.watch)

Source: <https://developers.google.com/workspace/calendar/api/guides/push>

- The address must be **HTTPS with a valid CA-signed certificate** whose hostname matches. Self-signed
  certificates are rejected. A laptop therefore needs a tunnel such as `cloudflared` or `ngrok`.
- Channel `id`: unique, ≤ 64 chars. Optional `token` ≤ 256 chars, echoed in `X-Goog-Channel-Token`.
  `params.ttl` requests a lifetime.
- Headers: `X-Goog-Channel-ID`, `X-Goog-Resource-ID`, `X-Goog-Resource-URI`, `X-Goog-Message-Number`,
  `X-Goog-Resource-State` (`sync` right after watch, then `exists`/`not_exists`), plus the optional
  `X-Goog-Channel-Token` and `X-Goog-Channel-Expiration`. Notifications carry **no event data**: the
  client has to call `events.list` with its sync token.
- Respond with 200/201/202/204/102. Google retries with backoff on 500/502/503/504.
- Channels are **not renewed automatically**. Stop them with `channels.stop` (`id` + `resourceId`).
- Tempo's default is **polling with sync tokens**. Webhooks are optional (`src/google/webhook.ts`).

## Google Tasks API

Sources: <https://developers.google.com/workspace/tasks/reference/rest/v1/tasks/list>, <https://developers.google.com/workspace/tasks/reference/rest/v1/tasks>, <https://developers.google.com/workspace/tasks/limits>

- `tasks.list` params: `showCompleted` (default **true**), `showHidden` (default false),
  `showDeleted` (default false), `showAssigned`, `completedMin/Max`, `dueMin/Max`, `updatedMin`,
  `maxResults` (default 20, **max 100**), `pageToken`.
- The docs say `showHidden` must be true to see tasks completed in Google's own apps (web, mobile).
  Those get flagged `hidden`.
- `completedMin` is a lower bound on the **completion date**. The docs do not say what happens to open
  tasks, which have no completion date. Third-party reports say they are excluded. Tempo therefore
  makes **two queries per list**: (1) `showCompleted=false, showHidden=true` for open tasks, and (2)
  `showCompleted=true, showHidden=true, completedMin=now-7d` for recent completions. It merges them by
  id, drops `deleted` tasks, and also filters on the completion date client-side.
- `due`: "Only date information is recorded; the time portion of the timestamp is discarded". The
  value looks like `2026-11-20T00:00:00.000Z`. Tempo reads the date part as a local date in the user's
  time zone and turns it into an exclusive deadline at the **next local midnight** (DST-safe through luxon).
- `parent`: output only, omitted for top-level tasks (one subtask level).
  `position`: output only, ordering among siblings (lexicographic). `completed` is set only for completed tasks.
- The Tasks API has **no push notifications** (no `watch` method), so tasks are polled.
- Quota: courtesy limit of **50,000 queries/day** per project.

## Calendar quotas and errors

Sources: <https://developers.google.com/workspace/calendar/api/guides/quota>, <https://developers.google.com/workspace/calendar/api/guides/errors>

- Limits: 10,000 requests/min per project and 600 requests/min per user per project (sliding window).
- `403 rateLimitExceeded` / `403 userRateLimitExceeded` / `429` and `500/503` call for
  **exponential backoff**: `min(2^n + jitter, max)`. Tempo does this in `src/google/retry.ts`
  (5 retries, base 500 ms, max 16 s).
- `410` on `syncToken` means wipe the store and re-sync. `404` on a calendar means it was deleted or is
  not accessible. `403 forbiddenForNonOrganizer` means only the organizer can change shared props.
- The docs advise randomising poll times (±25%) and preferring push over polling at scale.
