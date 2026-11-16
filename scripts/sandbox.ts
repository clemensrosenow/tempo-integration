/**
 * Developer sandbox: fills a TEST Google account with realistic sample
 * calendars, events and tasks, and simulates what the user would do in Google
 * Calendar / Google Tasks (extend a meeting, check off a task, drag a block,
 * answer an invitation …), so Tempo can be exercised live.
 *
 *   npm run sandbox -- login                 connect the test account (full Calendar + Tasks access)
 *   npm run sandbox -- seed                  create the sample week (idempotent: reset first)
 *   npm run sandbox -- reset                 delete everything the sandbox created (+ Tempo blocks)
 *   npm run sandbox -- show                  events (7 days) and tasks as the test account sees them
 *   npm run sandbox -- act <action> …        simulate a user action (see `act help`)
 *
 * Safety: only ever writes to the account recorded at `sandbox login`, and only
 * if that is the same account Tempo is signed in with (`tempo login`).
 * Everything it creates is tracked in .tempo/sandbox.json.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DateTime } from 'luxon';
import { calendar as calendarApi, type calendar_v3 } from 'googleapis/build/src/apis/calendar/index.js';
import { tasks as tasksApi, type tasks_v1 } from 'googleapis/build/src/apis/tasks/index.js';
import { loadConfig } from '../src/config.js';
import { getAuthorizedClient, readStoredToken, signIn } from '../src/google/auth.js';

const config = loadConfig();
const TZ = 'Europe/Berlin';
const MARK = 'tempoSandbox';
const ledgerFile = path.join(config.dataDir, 'sandbox.json');

interface Ledger {
  account?: string;
  calendars: string[];
  events: Array<{ calendarId: string; id: string }>;
  taskLists: string[];
  tasks: Array<{ listId: string; id: string }>;
}

async function loadLedger(): Promise<Ledger> {
  try {
    return { calendars: [], events: [], taskLists: [], tasks: [], ...JSON.parse(await fs.readFile(ledgerFile, 'utf8')) };
  } catch {
    return { calendars: [], events: [], taskLists: [], tasks: [] };
  }
}
async function saveLedger(l: Ledger): Promise<void> {
  await fs.writeFile(ledgerFile, JSON.stringify(l, null, 2), { mode: 0o600 });
}

async function clients() {
  const ledger = await loadLedger();
  const sandbox = await readStoredToken('sandbox', config.dataDir);
  const user = await readStoredToken('user', config.dataDir);
  if (!sandbox) throw new Error('Run `npm run sandbox -- login` with the TEST account first.');
  if (!ledger.account || ledger.account !== sandbox.email) throw new Error('Sandbox account not recorded; run `npm run sandbox -- login` again.');
  if (!user || user.email.toLowerCase() !== sandbox.email.toLowerCase()) {
    throw new Error(`Sandbox account ${sandbox.email} is not the account Tempo is signed in with (${user?.email ?? 'none'}). Refusing to write.`);
  }
  const auth = await getAuthorizedClient('sandbox', config.dataDir);
  return { cal: calendarApi({ version: 'v3', auth }), tasks: tasksApi({ version: 'v1', auth }), ledger, email: sandbox.email };
}

type Clients = Awaited<ReturnType<typeof clients>>;

// ---------------------------------------------------------------------------
// Time helpers: everything is relative to Monday of the current week.
// ---------------------------------------------------------------------------

const now = () => DateTime.now().setZone(TZ);
const monday = () => now().startOf('week');
/** Day offset from this week's Monday (0 = Mon, 7 = next Mon, -7 = last Mon) + local time. */
const at = (dayOffset: number, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return monday().plus({ days: dayOffset }).set({ hour: h!, minute: m!, second: 0, millisecond: 0 });
};
const dt = (d: DateTime) => ({ dateTime: d.toISO()!, timeZone: TZ });
/** Google Tasks due: a date, sent as midnight UTC. */
const due = (d: DateTime) => `${d.toISODate()}T00:00:00.000Z`;

// ---------------------------------------------------------------------------
// The sample week
// ---------------------------------------------------------------------------

async function seed(c: Clients): Promise<void> {
  const { cal, tasks, ledger } = c;
  if (ledger.events.length || ledger.tasks.length) throw new Error('Sample data exists; run `npm run sandbox -- reset` first.');

  const mkCal = async (summary: string, color: string, selected: boolean) => {
    const created = await cal.calendars.insert({ requestBody: { summary, timeZone: TZ } });
    const id = created.data.id!;
    ledger.calendars.push(id);
    await cal.calendarList.patch({ calendarId: id, colorRgbFormat: true, requestBody: { selected, backgroundColor: color, foregroundColor: '#ffffff' } });
    return id;
  };
  const ev = async (calendarId: string, body: calendar_v3.Schema$Event) => {
    const r = await cal.events.insert({
      calendarId,
      requestBody: { ...body, extendedProperties: { private: { [MARK]: '1' } } },
    });
    ledger.events.push({ calendarId, id: r.data.id! });
    return r.data;
  };

  // Calendars: lectures (shown), the student job (shown), sport (HIDDEN in the
  // sidebar — setup must not read it as busy unless the user adds it).
  const uni = await mkCal('LMU Lectures', '#1f6feb', true);
  const job = await mkCal('Werkstudent', '#8957e5', true);
  const sport = await mkCal('Sport', '#2da44e', false);
  const primary = 'primary';

  // Weekly rhythm, started 4 weeks ago so setup has history to learn from.
  const weekly = (day: number, from: string, to: string) => ({
    start: dt(at(day - 28, from)),
    end: dt(at(day - 28, to)),
    recurrence: [`RRULE:FREQ=WEEKLY;COUNT=8`],
  });
  await ev(uni, { summary: 'HCI Lecture', location: 'Hauptgebäude A140', ...weekly(0, '10:00', '12:00') });
  await ev(uni, { summary: 'Statistics Lecture', ...weekly(1, '14:00', '16:00') });
  await ev(uni, { summary: 'UI Design Lecture', ...weekly(2, '10:00', '12:00') });
  await ev(uni, { summary: 'Statistics Tutorial', ...weekly(3, '12:00', '13:30') });
  await ev(job, { summary: 'Werkstudent @ SAP', ...weekly(2, '13:00', '18:00') });
  await ev(job, { summary: 'Werkstudent @ SAP', ...weekly(4, '09:00', '15:00') });
  await ev(sport, { summary: 'Bouldering', ...weekly(1, '19:00', '21:00') });
  await ev(sport, { summary: 'Running club', ...weekly(3, '18:30', '19:30') });

  // One-off events this and next week.
  await ev(primary, { summary: 'Project group meeting', start: dt(at(0, '15:00')), end: dt(at(0, '16:00')) });
  await ev(primary, { summary: 'Dentist', location: 'Leopoldstr. 12', start: dt(at(1, '09:00')), end: dt(at(1, '10:00')) });
  await ev(primary, { summary: 'Lunch with Jonas', start: dt(at(1, '12:30')), end: dt(at(1, '13:30')) });
  await ev(primary, { summary: 'Optional: career fair (maybe)', start: dt(at(3, '14:00')), end: dt(at(3, '17:00')), transparency: 'transparent' });
  await ev(primary, { summary: "Lena's birthday dinner", start: dt(at(4, '19:00')), end: dt(at(4, '22:30')) });
  await ev(primary, { summary: 'Family visit', start: { date: at(5, '00:00').toISODate()! }, end: { date: at(7, '00:00').toISODate()! } });
  await ev(primary, { summary: 'Project group meeting', start: dt(at(7, '15:00')), end: dt(at(7, '16:00')) });
  await ev(primary, { summary: 'Thesis consultation (Prof. Weber)', start: dt(at(8, '11:00')), end: dt(at(8, '11:30')) });

  // Google Tasks: a "Uni" list and the default list.
  const uniList = (await tasks.tasklists.insert({ requestBody: { title: 'Uni' } })).data.id!;
  ledger.taskLists.push(uniList);
  const defaultList = (await tasks.tasklists.list({ maxResults: 100 })).data.items?.find((l) => !ledger.taskLists.includes(l.id!))?.id ?? '@default';
  const task = async (listId: string, body: tasks_v1.Schema$Task, parent?: string) => {
    const r = await tasks.tasks.insert({ tasklist: listId, requestBody: body, ...(parent ? { parent } : {}) });
    ledger.tasks.push({ listId, id: r.data.id! });
    return r.data;
  };
  const today = now().startOf('day');
  await task(uniList, { title: 'Submit UI design exercise sheet 4', due: due(today.plus({ days: 1 })), notes: 'Upload to Moodle' });
  await task(uniList, { title: 'Prepare HCI presentation slides', due: due(at(3, '00:00')), notes: '~3h, 15 min talk on Thursday' });
  const paper = await task(uniList, { title: 'Seminar paper: AI calendar agents', due: due(at(11, '00:00')) });
  // Subtasks are inserted in reverse so they end up in this order.
  await task(uniList, { title: 'Draft introduction and related work' }, paper.id!);
  await task(uniList, { title: 'Write outline' }, paper.id!);
  await task(uniList, { title: 'Literature search (10 sources)' }, paper.id!);
  await task(uniList, { title: 'Statistics exam preparation', due: due(today.plus({ days: 24 })), notes: 'about 20 hours in total' });
  await task(uniList, { title: 'Email Prof. Weber questions for consultation', due: due(at(7, '00:00')) });
  await task(defaultList, { title: "Buy birthday present for Lena", due: due(at(3, '00:00')) });
  await task(defaultList, { title: 'Reply to landlord about heating' });
  await task(defaultList, { title: 'Book train to Hamburg', due: due(today.minus({ days: 1 })), notes: 'For the family visit; prices go up' });
  await task(defaultList, { title: 'Tax return 2025', due: due(today.minus({ days: 190 })) });
  await task(defaultList, { title: 'Renew library books', status: 'completed', due: due(today.minus({ days: 2 })) });

  // New calendars start out shown; hide Sport now that Google has settled.
  await cal.calendarList.patch({ calendarId: sport, requestBody: { selected: false } });
  await saveLedger(ledger);
  console.log(`Seeded ${ledger.calendars.length} calendars, ${ledger.events.length} events, ${ledger.tasks.length} tasks for ${c.email}.`);
}

async function reset(c: Clients): Promise<void> {
  const { cal, tasks, ledger } = c;
  const ignore404 = (e: unknown) => {
    const code = (e as { code?: number; status?: number }).code ?? (e as { status?: number }).status;
    if (code !== 404 && code !== 410) throw e;
  };
  for (const e of ledger.events.filter((e) => !ledger.calendars.includes(e.calendarId))) {
    await cal.events.delete({ calendarId: e.calendarId, eventId: e.id, sendUpdates: 'none' }).catch(ignore404);
  }
  for (const id of ledger.calendars) await cal.calendars.delete({ calendarId: id }).catch(ignore404);
  for (const t of ledger.tasks) await tasks.tasks.delete({ tasklist: t.listId, task: t.id }).catch(ignore404);
  for (const id of ledger.taskLists) await tasks.tasklists.delete({ tasklist: id }).catch(ignore404);
  // Tempo's own calendar in the test account (blocks + metadata) goes too.
  const list = await cal.calendarList.list({ maxResults: 250 });
  for (const entry of list.data.items ?? []) {
    if (entry.description?.includes('[tempo-calendar]')) await cal.calendars.delete({ calendarId: entry.id! }).catch(ignore404);
  }
  // Invitation copies from the organizer in the primary calendar.
  const inv = await cal.events.list({ calendarId: 'primary', q: 'Tempo asks', maxResults: 250 });
  for (const e of inv.data.items ?? []) await cal.events.delete({ calendarId: 'primary', eventId: e.id!, sendUpdates: 'none' }).catch(ignore404);
  await saveLedger({ account: ledger.account, calendars: [], events: [], taskLists: [], tasks: [] });
  console.log('Sandbox data removed. Run `npm run tempo -- setup` again after seeding (Tempo calendar was deleted).');
}

async function show(c: Clients): Promise<void> {
  const { cal, tasks } = c;
  const from = now().startOf('day');
  const to = from.plus({ days: 8 });
  const cals = (await cal.calendarList.list({ maxResults: 250 })).data.items ?? [];
  const rows: Array<{ s: DateTime; line: string }> = [];
  for (const k of cals) {
    const items = (
      await cal.events.list({ calendarId: k.id!, timeMin: from.toISO()!, timeMax: to.toISO()!, singleEvents: true, maxResults: 250 })
    ).data.items ?? [];
    for (const e of items) {
      const s = e.start?.dateTime ? DateTime.fromISO(e.start.dateTime).setZone(TZ) : DateTime.fromISO(e.start!.date!, { zone: TZ });
      const f = e.end?.dateTime ? DateTime.fromISO(e.end.dateTime).setZone(TZ) : DateTime.fromISO(e.end!.date!, { zone: TZ });
      const time = e.start?.dateTime ? `${s.toFormat('HH:mm')}-${f.toFormat('HH:mm')}` : 'all-day    ';
      const me = e.attendees?.find((a) => a.self)?.responseStatus;
      rows.push({ s, line: `${s.toFormat('ccc dd')} ${time}  [${k.summaryOverride ?? k.summary}] ${e.summary}${e.transparency === 'transparent' ? ' (free)' : ''}${me ? ` (rsvp: ${me})` : ''}` });
    }
  }
  rows.sort((a, b) => a.s.toMillis() - b.s.toMillis());
  console.log(rows.map((r) => r.line).join('\n'));
  console.log('\nTasks:');
  for (const l of (await tasks.tasklists.list({ maxResults: 100 })).data.items ?? []) {
    const items = (await tasks.tasks.list({ tasklist: l.id!, showCompleted: true, showHidden: true, maxResults: 100 })).data.items ?? [];
    for (const t of items) console.log(`  [${l.title}] ${t.status === 'completed' ? '[x]' : '[ ]'} ${t.parent ? '  ↳ ' : ''}${t.title}${t.due ? ` (due ${t.due.slice(0, 10)})` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// Simulated user actions
// ---------------------------------------------------------------------------

async function findEvent(c: Clients, title: string, opts: { calendarId?: string; future?: boolean } = {}) {
  const cals = opts.calendarId ? [{ id: opts.calendarId }] : (await c.cal.calendarList.list({ maxResults: 250 })).data.items ?? [];
  const from = now().minus({ hours: 12 });
  const hits: Array<{ calendarId: string; e: calendar_v3.Schema$Event }> = [];
  for (const k of cals) {
    const items = (
      await c.cal.events.list({ calendarId: k.id!, timeMin: from.toISO()!, timeMax: from.plus({ days: 14 }).toISO()!, singleEvents: true, orderBy: 'startTime', maxResults: 250 })
    ).data.items ?? [];
    for (const e of items) if (e.summary?.toLowerCase().includes(title.toLowerCase())) hits.push({ calendarId: k.id!, e });
  }
  const future = opts.future ? hits.filter((h) => DateTime.fromISO(h.e.start!.dateTime ?? h.e.start!.date!) > now()) : hits;
  if (future.length === 0) throw new Error(`No event matching "${title}"`);
  return future[0]!;
}

async function findTask(c: Clients, title: string) {
  for (const l of (await c.tasks.tasklists.list({ maxResults: 100 })).data.items ?? []) {
    const items = (await c.tasks.tasks.list({ tasklist: l.id!, showCompleted: true, maxResults: 100 })).data.items ?? [];
    const t = items.find((t) => t.title?.toLowerCase().includes(title.toLowerCase()));
    if (t) return { listId: l.id!, t };
  }
  throw new Error(`No task matching "${title}"`);
}

const shift = (iso: string, minutes: number) => DateTime.fromISO(iso).plus({ minutes }).toISO()!;

async function act(c: Clients, action: string | undefined, args: string[]): Promise<void> {
  const { cal, tasks, ledger } = c;
  switch (action) {
    case 'extend': {
      // Meeting overrun: extend an event's end by N minutes.
      const [title, min] = args;
      const { calendarId, e } = await findEvent(c, title!);
      await cal.events.patch({ calendarId, eventId: e.id!, requestBody: { end: { dateTime: shift(e.end!.dateTime!, Number(min)), timeZone: TZ } } });
      console.log(`Extended "${e.summary}" by ${min} min.`);
      return;
    }
    case 'move': {
      // Drag any event (incl. a Tempo block) by N minutes.
      const [title, min] = args;
      const { calendarId, e } = await findEvent(c, title!, { future: true });
      await cal.events.patch({
        calendarId,
        eventId: e.id!,
        requestBody: { start: { dateTime: shift(e.start!.dateTime!, Number(min)), timeZone: TZ }, end: { dateTime: shift(e.end!.dateTime!, Number(min)), timeZone: TZ } },
      });
      console.log(`Moved "${e.summary}" (${e.start!.dateTime}) by ${min} min.`);
      return;
    }
    case 'resize': {
      // Change an event's (e.g. Tempo block's) length to N minutes.
      const [title, min] = args;
      const { calendarId, e } = await findEvent(c, title!, { future: true });
      await cal.events.patch({ calendarId, eventId: e.id!, requestBody: { end: { dateTime: shift(e.start!.dateTime!, Number(min)), timeZone: TZ } } });
      console.log(`Resized "${e.summary}" to ${min} min.`);
      return;
    }
    case 'add-event': {
      // add-event "<title>" <dayOffsetFromMonday> HH:mm HH:mm [free]
      const [title, day, from, to, free] = args;
      const r = await cal.events.insert({
        calendarId: 'primary',
        requestBody: {
          summary: title,
          start: dt(at(Number(day), from!)),
          end: dt(at(Number(day), to!)),
          ...(free === 'free' ? { transparency: 'transparent' } : {}),
          extendedProperties: { private: { [MARK]: '1' } },
        },
      });
      ledger.events.push({ calendarId: 'primary', id: r.data.id! });
      await saveLedger(ledger);
      console.log(`Added "${title}" ${r.data.start?.dateTime}–${r.data.end?.dateTime}.`);
      return;
    }
    case 'cancel-event': {
      const { calendarId, e } = await findEvent(c, args[0]!, { future: true });
      await cal.events.delete({ calendarId, eventId: e.id!, sendUpdates: 'none' });
      console.log(`Deleted "${e.summary}".`);
      return;
    }
    case 'complete':
    case 'reopen': {
      const { listId, t } = await findTask(c, args[0]!);
      await tasks.tasks.patch({ tasklist: listId, task: t.id!, requestBody: action === 'complete' ? { status: 'completed' } : { status: 'needsAction', completed: null } });
      console.log(`${action === 'complete' ? 'Completed' : 'Reopened'} "${t.title}".`);
      return;
    }
    case 'add-task': {
      // add-task "<title>" [dueInDays|-] [notes…]
      const [title, dueIn, ...notes] = args;
      const listId = (await tasks.tasklists.list({ maxResults: 100 })).data.items?.[0]?.id ?? '@default';
      const r = await tasks.tasks.insert({
        tasklist: listId,
        requestBody: {
          title,
          ...(dueIn && dueIn !== '-' ? { due: due(now().startOf('day').plus({ days: Number(dueIn) })) } : {}),
          ...(notes.length ? { notes: notes.join(' ') } : {}),
        },
      });
      ledger.tasks.push({ listId, id: r.data.id! });
      await saveLedger(ledger);
      console.log(`Added task "${title}".`);
      return;
    }
    case 'edit-task': {
      // edit-task "<title>" [title=…] [due=<days>|none] [notes=…]
      const { listId, t } = await findTask(c, args[0]!);
      const body: tasks_v1.Schema$Task = {};
      for (const kv of args.slice(1)) {
        const [k, ...rest] = kv.split('=');
        const v = rest.join('=');
        if (k === 'title') body.title = v;
        if (k === 'notes') body.notes = v;
        if (k === 'due') body.due = v === 'none' ? null : due(now().startOf('day').plus({ days: Number(v) }));
      }
      await tasks.tasks.patch({ tasklist: listId, task: t.id!, requestBody: body });
      console.log(`Edited "${t.title}": ${JSON.stringify(body)}`);
      return;
    }
    case 'rsvp': {
      // rsvp <yes|no|maybe> — answer the open "Tempo asks:" invitation.
      const map = { yes: 'accepted', no: 'declined', maybe: 'tentative' } as const;
      const answer = map[args[0] as keyof typeof map];
      if (!answer) throw new Error('rsvp yes|no|maybe');
      // Invitations from unknown senders may be hidden from events.list, so
      // look the open question up by id (Tempo's state) and fetch it directly.
      const state = JSON.parse(await fs.readFile(path.join(config.dataDir, 'state.json'), 'utf8')) as {
        questions: Array<{ status: string; inviteEventId?: string }>;
      };
      const open = state.questions.find((q) => q.status === 'open' && q.inviteEventId);
      if (!open) throw new Error('No open Tempo question.');
      const e = (await cal.events.get({ calendarId: 'primary', eventId: open.inviteEventId! })).data;
      const attendees = (e.attendees ?? []).map((a) => (a.self ? { ...a, responseStatus: answer } : a));
      await cal.events.patch({ calendarId: 'primary', eventId: e.id!, requestBody: { attendees } });
      console.log(`Answered "${e.summary}" with ${args[0]}.`);
      return;
    }
    case 'show-calendar': {
      // Toggle the sidebar checkbox: show-calendar "<name>" on|off
      const [name, on] = args;
      const entry = ((await cal.calendarList.list({ maxResults: 250 })).data.items ?? []).find((k) => (k.summaryOverride ?? k.summary)?.toLowerCase() === name!.toLowerCase());
      if (!entry) throw new Error(`No calendar "${name}"`);
      await cal.calendarList.patch({ calendarId: entry.id!, requestBody: { selected: on !== 'off' } });
      console.log(`Calendar "${name}" ${on !== 'off' ? 'shown' : 'hidden'}.`);
      return;
    }
    default:
      console.log(
        [
          'act extend "<event>" <min>          meeting overrun',
          'act move "<event|block>" <min>      drag (future occurrence)',
          'act resize "<event|block>" <min>    set length',
          'act add-event "<title>" <day> HH:mm HH:mm [free]   day = offset from this Monday',
          'act cancel-event "<event>"',
          'act complete|reopen "<task>"',
          'act add-task "<title>" [dueInDays|-] [notes…]',
          'act edit-task "<task>" [title=…] [due=<days>|none] [notes=…]',
          'act rsvp yes|no|maybe               answer the open "Tempo asks:" invitation',
          'act show-calendar "<name>" on|off   Google Calendar sidebar checkbox',
        ].join('\n'),
      );
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'login') {
    const { email } = await signIn('sandbox', { dataDir: config.dataDir, log: console.log });
    const ledger = await loadLedger();
    if (ledger.account && ledger.account !== email && (ledger.events.length || ledger.tasks.length)) {
      throw new Error(`Sample data of ${ledger.account} still recorded; reset it before switching accounts.`);
    }
    await saveLedger({ ...ledger, account: email });
    console.log(`Sandbox writes go to ${email} only.`);
    return;
  }
  const c = await clients();
  if (command === 'seed') return seed(c);
  if (command === 'reset') return reset(c);
  if (command === 'show') return show(c);
  if (command === 'act') return act(c, args[0], args.slice(1));
  console.log('Usage: npm run sandbox -- login | seed | reset | show | act <action> …');
}

main().catch((err: unknown) => {
  console.error(`sandbox: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
