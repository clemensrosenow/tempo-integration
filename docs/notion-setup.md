# Tempo for Notion Calendar

Tempo reads open work from one Notion task database and publishes a rolling plan to a private **Tempo Sessions** database. Google Calendar supplies busy intervals through FreeBusy. The original Notion task is where you maintain deadlines and mark work complete. Use Tempo Sessions to plan when to work.

## Get the first plan

1. Set `NOTION_API_TOKEN` in the environment or `.env`. In Notion, use **Connections** to share your existing task database and a private page that will hold Tempo Sessions. The Notion integration needs read, insert and update content capabilities.
2. Copy `tempo.notion.example.json` to `tempo.notion.json`. Fill in `notion.sessionsParent` with the private page URL. The defaults are 10:00–20:00 Monday through Friday in Europe/Berlin. Add weekend hours if desired.
3. With `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` configured for a Desktop OAuth client, run `npm run notion -- login`. If you already have a compatible Google token, the app uses `GOOGLE_REFRESH_TOKEN`, `GOOGLE_ACCESS_TOKEN`, or the existing Tempo user grant. Enable the Google Calendar API for your OAuth project. Run `npm run notion -- calendars` if you want to replace `primary` or add more calendar IDs to `google.calendars`. Select calendars that carry your real commitments.
4. Run `npm run notion -- setup`. Check the workspace, completion rule, sample tasks and first two days. If several shared databases match, paste the task database or data source URL into `notion.taskSource` and rerun. Use `setup --hours-only` to explore without Google availability. Run `npm run notion -- start` after approving a conflict-aware preview.
5. Open the Tempo Sessions database from the URL in the terminal. In its **Calendar** view on desktop or web, use **Open in Calendar** or add the database from the Notion Calendar sidebar. Check that it uses **Scheduled time**, and look for the sample task printed by Tempo. Run `npm run notion -- visible`, then `npm run notion -- watch` on the machine where you want planning to run.

Use `npm ci` before running the commands from a fresh checkout. `npm run build` also builds the standalone `tempo-notion` command. Run `npm run notion -- help` to see the full command list.

## Working with the plan

- Drag a session on desktop or web to pin the new start. Change the end time to adjust the duration. Set **Control** to **Flexible** to allow repairs again.
- Set **Control** to **Skip session** to leave the time open. Choose **Resume** from **Decision** when you're ready to plan more time. If a session elapsed and the work is still open, Tempo keeps it as history and waits for a decision before adding more time.
- Open **Needs attention** in Tempo Sessions to find deadline risks and work that could not fit. **Use suggested time** confirms the displayed opening after a fresh availability check. **Find another time** asks for another opening. **Leave unscheduled** keeps the time open. Use **Recent changes** and **Decision → Undo move** to restore a previous opening when it still fits.
- Mark work complete in the original task database. Tempo clears its future session dates and keeps past sessions. The source record, its properties and its relations are read-only throughout.
- Use `status` for the last successful update, `pause` to suspend scheduling, and `setup` followed by `resume` to preview and resume. Run `login` again if Google authorization expires. Disconnect with `disconnect --keep` to retain the displayed plan or `disconnect --clear` to clear upcoming dates first. Existing credentials supplied by environment variables or the legacy app remain managed by their owner.

On mobile, open the session in Notion to edit date and control properties. Keep the Watch process running for updates. A local settings change takes effect at the next poll. The integration uses one worker per installation and stores its connection and retry state under `.tempo/notion/`.

## Task schema and settings

Tempo looks for a Status, Select, or checkbox completion field, recognizes common English and German property names, and remembers confirmed field and option IDs across renames. Useful optional fields are **Due**, **Estimated Minutes**, **Priority**, **Notes**, **Project** and **Area**. It reads date, formula and rollup results where their values fit the mapped field. Waiting, blocked, parked and someday statuses are excluded by default. Blank or invalid duration and priority values fall back to the task title, notes, and page body. Estimates are labeled on the session.

Override field names or IDs in `notion.mapping` using `completion`, `done`, `parked`, `due`, `duration`, `durationFallback`, `durationUnit`, `priority`, `notes`, `project`, or `area`. `done` and `parked` are lists of status names or IDs. Use `durationUnit: "hours"` for properties whose bare numeric values represent hours. Rerun `setup` and `resume` to confirm mapping changes.

Settings also accept `horizonDays` (7), `pollSeconds` (90), `maxAutomaticMoveDays` (2), `maxAutomaticMoves` (3), and `protectedMinutes` (60). Task dates without a time are due at the end of that day's working window. Timed deadlines constrain automatic scheduling, and the planner keeps feasible existing sessions before placing new work. Google distinguishes busy and free time, and Tempo uses its returned intervals without reading event content.

Use `notion.createTasksIfMissing: true` only after confirming the workspace genuinely has no task database. Notion's API only discovers sources shared with the connection. Tempo requires this explicit setting and an approved setup before creating a starter task database, and it requires that discovery sees no existing database.

## Platform references

- [Add a Notion database to Notion Calendar](https://www.notion.com/help/use-notion-calendar-with-notion)
- [Notion database views API](https://developers.notion.com/reference/create-view)
- [Google Calendar FreeBusy API](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query)
