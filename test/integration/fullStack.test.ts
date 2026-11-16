/**
 * Full stack without network: real Google adapters (mapping, extended
 * properties, invitations) over a stateful Google REST simulator, real
 * onboarding, engine, planning pipeline and the heuristic LLM provider.
 */
import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { GoogleCalendarAdapter } from '../../src/google/calendarAdapter.js';
import { GoogleTasksAdapter } from '../../src/google/tasksAdapter.js';
import { GoogleInviteAdapter } from '../../src/google/inviteAdapter.js';
import { HeuristicLlm } from '../../src/llm/heuristic.js';
import { MemoryStateStore } from '../../src/store/memoryStore.js';
import { TempoEngine } from '../../src/engine/engine.js';
import { confirmSetup, proposeSetup } from '../../src/engine/setup.js';
import { GoogleSim } from './googleSim.js';

const TZ = 'Europe/Berlin';
const USER = 'student@example.com';
const ORG = 'tempo.organizer@example.com';
const local = (iso: string) => DateTime.fromISO(iso, { zone: TZ });
const dt = (iso: string) => ({ dateTime: local(iso).toISO()!, timeZone: TZ });

function overlaps(a: { s: number; e: number }, b: { s: number; e: number }) {
  return a.s < b.e && b.s < a.e;
}
const span = (ev: { start?: { dateTime?: string | null } | null; end?: { dateTime?: string | null } | null }) => ({
  s: new Date(ev.start!.dateTime!).getTime(),
  e: new Date(ev.end!.dateTime!).getTime(),
});

describe('full stack over simulated Google', () => {
  it('onboards, plans, learns from a drag, asks and applies a Yes', async () => {
    let now = local('2026-11-23T08:00').toJSDate(); // Monday
    const clock = () => new Date(now);
    const advance = (min: number) => (now = new Date(now.getTime() + min * 60_000));
    const sim = new GoogleSim(USER, ORG, clock);
    const noRetry = { retries: 0, sleep: async () => {} };

    // A shared lecture calendar plus the student's own events.
    sim.addCalendar('lmu@group.calendar.google.com', 'prof@lmu.de', { summary: 'LMU lectures', accessRole: 'reader', timeZone: TZ });
    sim.share('lmu@group.calendar.google.com', USER);
    sim.addCalendar('de.german#holiday@group.v.calendar.google.com', 'google', { summary: 'Holidays', accessRole: 'reader', timeZone: TZ });
    sim.share('de.german#holiday@group.v.calendar.google.com', USER);
    for (const day of ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23']) {
      sim.addEvent('lmu@group.calendar.google.com', { summary: 'HCI lecture', start: dt(`${day}T10:00`), end: dt(`${day}T12:00`) });
    }
    const meeting = sim.addEvent(USER, { summary: 'Project meeting', start: dt('2026-11-23T13:00'), end: dt('2026-11-23T14:00') });
    sim.addEvent(USER, { summary: 'Skipped tutorial', start: dt('2026-11-23T15:00'), end: dt('2026-11-23T16:00'), transparency: 'transparent' });

    const slides = sim.addTask({ title: 'Pitch slides presentation', due: '2026-11-23T00:00:00.000Z' });
    const parent = sim.addTask({ title: 'Seminar paper', due: '2026-11-27T00:00:00.000Z' });
    const step1 = sim.addTask({ title: 'Read sources for seminar paper', parent: parent.id });
    const step2 = sim.addTask({ title: 'Write essay outline', parent: parent.id });

    const calendar = new GoogleCalendarAdapter(null, { api: sim.calendarApi(USER), organizerEmail: ORG, retry: noRetry, now: clock });
    const tasks = new GoogleTasksAdapter(null, () => TZ, { api: sim.tasksApi(), retry: noRetry, now: clock });
    const invites = new GoogleInviteAdapter(null, { api: sim.calendarApi(ORG), timeZone: TZ, cancelSendUpdates: 'none', retry: noRetry });
    const store = new MemoryStateStore();
    const log: string[] = [];
    const engine = new TempoEngine({
      calendar,
      tasks,
      invites,
      llm: new HeuristicLlm(),
      store,
      config: { horizonDays: 7, debounceMs: 90_000 },
      clock,
      log: (l) => log.push(l),
    });

    // --- E1 onboarding --------------------------------------------------------------
    const proposal = await proposeSetup(calendar, clock());
    expect(proposal.userEmail).toBe(USER);
    expect(proposal.prefs.selectedCalendarIds).toContain('lmu@group.calendar.google.com');
    expect(proposal.prefs.selectedCalendarIds).not.toContain('de.german#holiday@group.v.calendar.google.com');
    await confirmSetup(calendar, store, proposal);
    const tempoId = sim.tempoCalendarId();
    expect(tempoId).toBeDefined();
    const state0 = await store.load();
    // Pin hours for a deterministic scenario (normally confirmed by the user).
    state0.prefs = {
      ...state0.prefs!,
      workingHours: { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] },
      focusTime: { start: '09:00', end: '12:00' },
      bufferMin: 0,
    };
    await store.save(state0);

    // --- first plan ---------------------------------------------------------------
    const fixedBefore = JSON.stringify([sim.events(USER), sim.events('lmu@group.calendar.google.com')]);
    const r1 = await engine.tick({ force: true });
    expect(r1.failed).toEqual([]);
    const blocks = sim.events(tempoId!);
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) {
      expect(b.extendedProperties?.private?.tempo).toBeDefined();
      expect(b.description ?? '').not.toBe('');
    }
    expect(JSON.stringify([sim.events(USER), sim.events('lmu@group.calendar.google.com')])).toBe(fixedBefore); // E7/E13
    const busy = [...sim.events(USER).filter((e) => e.transparency !== 'transparent'), ...sim.events('lmu@group.calendar.google.com')].map(span);
    for (const b of blocks) for (const f of busy) expect(overlaps(span(b), f)).toBe(false);
    const byTask = (id: string) => blocks.filter((b) => b.extendedProperties?.private?.tempoTaskId === id);
    expect(byTask(slides.id!).every((b) => span(b).e <= local('2026-11-24T00:00').toMillis())).toBe(true); // due today → today
    expect(byTask(parent.id!)).toHaveLength(0); // parent planned through its subtasks (E4)
    const s1 = byTask(step1.id!).map(span);
    const s2 = byTask(step2.id!).map(span);
    expect(s1.length && s2.length).toBeTruthy();
    expect(Math.max(...s1.map((x) => x.e))).toBeLessThanOrEqual(Math.min(...s2.map((x) => x.s))); // order kept
    // The Free tutorial slot is usable time (E7).
    expect(log.join('\n')).not.toMatch(/apply .* failed/);

    // --- E12: user drags a later block by one hour ---------------------------------
    advance(5);
    if (process.env.DEBUG_SIM) console.log(sim.events(tempoId!).map((b) => `${b.summary} ${b.start?.dateTime} ${b.end?.dateTime}`));
    const target = sim.events(tempoId!).find((b) => span(b).s > now.getTime() + 2 * 3_600_000)!;
    expect(target).toBeDefined();
    const moved = { s: span(target).s + 3_600_000, e: span(target).e + 3_600_000 };
    sim.editEvent(tempoId!, target.id!, {
      start: { dateTime: new Date(moved.s).toISOString() },
      end: { dateTime: new Date(moved.e).toISOString() },
    });
    expect((await engine.tick()).outcome).toBe('deferred'); // E8 debounce
    advance(2);
    const r2 = await engine.tick();
    expect(r2.outcome).toBe('planned');
    const after = sim.events(tempoId!).find((b) => b.id === target.id)!;
    expect(span(after)).toEqual(moved); // stays where the user put it
    expect(after.description).toMatch(/Tempo learned/);
    expect(after.extendedProperties?.private?.tempoPlannedStart).toBe(new Date(moved.s).toISOString());

    // --- E6: meeting overrun → quiet repair -----------------------------------------
    now = local('2026-11-23T13:50').toJSDate();
    await engine.tick();
    sim.editEvent(USER, meeting.id!, { end: dt('2026-11-23T14:45') });
    advance(2);
    await engine.tick({ force: true });
    for (const b of sim.events(tempoId!)) {
      if (span(b).e <= now.getTime()) continue;
      expect(overlaps(span(b), { s: local('2026-11-23T13:00').toMillis(), e: local('2026-11-23T14:45').toMillis() })).toBe(false);
    }

    // --- E9/E10: impossible deadline → invitation → Yes ------------------------------
    advance(5);
    const thesis = sim.addTask({ title: 'Thesis chapter draft and literature review', notes: 'needs ~12 hours', due: '2026-11-23T00:00:00.000Z' });
    advance(3);
    const r3 = await engine.tick();
    if (process.env.DEBUG_SIM) console.log(r3.log.join('\n'), JSON.stringify((await store.load()).estimates[thesis.id!]));
    expect(r3.questionsOpened).toHaveLength(1);
    const q = r3.questionsOpened[0]!;
    const orgInvite = sim.events(ORG).find((e) => e.id === q.inviteEventId)!;
    expect(orgInvite.summary).toMatch(/^Tempo asks: /);
    expect(orgInvite.attendees?.[0]?.email).toBe(USER);
    const copy = sim.events(USER).find((e) => e.id === q.inviteEventId)!;
    expect(copy).toBeDefined(); // lands in the student's primary calendar
    // The invitation copy is not treated as busy time / a fixed event:
    const evs = await calendar.listEvents([USER], { start: now, end: new Date(now.getTime() + 7 * 86_400_000) });
    expect(evs.find((e) => e.id === q.inviteEventId)?.tempo?.kind).toBe('question');

    advance(10);
    sim.rsvp(q.inviteEventId!, 'accepted');
    advance(2);
    const r4 = await engine.tick();
    expect(r4.questionsClosed.map((x) => x.status)).toContain('yes');
    expect(sim.events(ORG).some((e) => e.id === q.inviteEventId)).toBe(false); // invitation removed
    expect(sim.events(tempoId!).some((b) => b.extendedProperties?.private?.tempoTaskId === thesis.id)).toBe(true);

    // --- done signal --------------------------------------------------------------------
    advance(5);
    sim.completeTask(step1.id!);
    advance(3);
    await engine.tick();
    expect(sim.events(tempoId!).some((b) => b.extendedProperties?.private?.tempoTaskId === step1.id && span(b).s > now.getTime())).toBe(false);
  });
});
