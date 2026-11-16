/**
 * End-to-end: onboarding → first plan → repair after a meeting overrun →
 * task done → critical decision via invitation → RSVP. Real engine, real
 * planning pipeline, real onboarding inference; Google replaced by an
 * in-memory fake, the LLM by a stub with fixed answers.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { TempoEngine } from '../../src/engine/engine.js';
import { confirmSetup, proposeSetup } from '../../src/engine/setup.js';
import type { LlmPort } from '../../src/core/ports.js';
import type { CalendarEvent, TaskEstimate } from '../../src/core/types.js';
import { isBusyFixedEvent } from '../../src/core/types.js';
import { FakeClock, FakeGoogle, FakeInvites, InMemoryStore } from './fakeGoogle.js';

const TZ = 'Europe/Berlin';
const local = (iso: string) => DateTime.fromISO(iso, { zone: TZ }).toJSDate();

const ESTIMATES: Record<string, Omit<TaskEstimate, 'taskId'>> = {
  'Pitch slides': { durationMin: 120, priority: 5, urgency: 5, confidence: 0.9, minChunkMin: 30, deepWork: true },
  'Read paper for seminar': { durationMin: 90, priority: 3, urgency: 2, confidence: 0.9, minChunkMin: 30, deepWork: false },
  'Thesis chapter draft': { durationMin: 600, priority: 5, urgency: 5, confidence: 0.9, minChunkMin: 60, deepWork: true },
};

const stubLlm: LlmPort = {
  name: 'stub',
  async understand(req) {
    return req.tasks.map((t) => ({
      taskId: t.id,
      ...(ESTIMATES[t.title] ?? { durationMin: 30, priority: 3, urgency: 3, confidence: 0.9, minChunkMin: 15, deepWork: false }),
    }));
  },
  async place() {
    return null;
  },
  async explain() {
    return {};
  },
};

function overlaps(a: { start: Date; end: Date }, b: { start: Date; end: Date }): boolean {
  return a.start < b.end && b.start < a.end;
}

function assertPlanInvariants(google: FakeGoogle, now: Date) {
  const blocks = google.tempoBlocks().filter((b) => b.start >= now);
  const busy = google.fixedEvents().filter(isBusyFixedEvent);
  for (const b of blocks) {
    for (const f of busy) expect(overlaps(b, f), `${b.title} overlaps ${f.title}`).toBe(false);
    const s = DateTime.fromJSDate(b.start).setZone(TZ);
    const e = DateTime.fromJSDate(b.end).setZone(TZ);
    expect(s.hour * 60 + s.minute).toBeGreaterThanOrEqual(9 * 60);
    expect(e.hour * 60 + e.minute).toBeLessThanOrEqual(18 * 60);
    expect(s.weekday).toBeLessThanOrEqual(5);
  }
  for (let i = 1; i < blocks.length; i++) {
    expect(overlaps(blocks[i - 1]!, blocks[i]!), 'Tempo blocks overlap each other').toBe(false);
  }
}

const minutes = (evs: CalendarEvent[]) => evs.reduce((m, e) => m + (+e.end - +e.start) / 60_000, 0);

describe('Tempo engine end-to-end', () => {
  let clock: FakeClock;
  let google: FakeGoogle;
  let invites: FakeInvites;
  let store: InMemoryStore;
  let engine: TempoEngine;
  const log: string[] = [];

  beforeEach(async () => {
    clock = new FakeClock(local('2026-11-23T08:00')); // Monday
    google = new FakeGoogle(clock);
    invites = new FakeInvites(google, clock);
    store = new InMemoryStore();
    engine = new TempoEngine({
      calendar: google,
      tasks: google,
      invites,
      llm: stubLlm,
      store,
      config: { horizonDays: 7, debounceMs: 90_000 },
      clock: clock.fn,
      log: (l) => log.push(l),
    });

    google.addFixed({ title: 'Lecture HCI', calendarId: 'uni', start: '2026-11-23T09:00:00Z', end: '2026-11-23T11:00:00Z' });
    google.addFixed({ title: 'Project meeting', start: '2026-11-23T12:00:00Z', end: '2026-11-23T13:00:00Z' });

    const proposal = await proposeSetup(google, clock.fn(), {
      timezone: TZ,
      workingHours: { start: '09:00', end: '18:00' },
      workingDays: [1, 2, 3, 4, 5],
      focusTime: { start: '09:00', end: '12:00' },
      sleep: { start: '23:00', end: '07:00' },
      calendarIds: ['student@example.com', 'uni'],
    });
    await confirmSetup(google, store, proposal);
    store.state.prefs!.bufferMin = 0;
  });

  it('plans tasks into free time of the Tempo calendar only, never touching fixed events', async () => {
    const slides = google.addTask({ title: 'Pitch slides', due: local('2026-11-24T00:00') });
    const paper = google.addTask({ title: 'Read paper for seminar', due: local('2026-11-27T00:00') });
    const fixedBefore = JSON.stringify(google.fixedEvents());

    const r = await engine.tick({ force: true });
    expect(r.outcome).toBe('planned');
    expect(JSON.stringify(google.fixedEvents())).toBe(fixedBefore); // E7
    const blocks = google.tempoBlocks();
    expect(blocks.every((b) => b.calendarId === 'tempo')).toBe(true); // E2/E13
    expect(minutes(blocks.filter((b) => b.tempo!.taskId === slides.id))).toBe(120);
    expect(minutes(blocks.filter((b) => b.tempo!.taskId === paper.id))).toBe(90);
    // Next hour is locked: nothing before 09:00 local.
    expect(blocks.every((b) => b.start >= local('2026-11-23T09:00'))).toBe(true);
    // Slides are due today → planned today (E5).
    expect(blocks.filter((b) => b.tempo!.taskId === slides.id).every((b) => b.end <= local('2026-11-24T00:00'))).toBe(true);
    // Every block explains itself (E11).
    expect(blocks.every((b) => (b.description ?? '').length > 0)).toBe(true);
    assertPlanInvariants(google, clock.fn());

    // A second tick without changes is stable (E8 minimal change).
    google.writes = [];
    clock.advanceMin(1);
    await engine.tick();
    expect(google.writes).toEqual([]);
  });

  it('repairs quietly after a meeting overrun, debouncing the edit (hero scenario)', async () => {
    google.addTask({ title: 'Pitch slides', due: local('2026-11-24T00:00') });
    google.addTask({ title: 'Read paper for seminar', due: local('2026-11-27T00:00') });
    await engine.tick({ force: true });

    clock.set(local('2026-11-23T13:50').toISOString());
    await engine.tick();
    const meeting = google.fixedEvents().find((e) => e.title === 'Project meeting')!;
    google.userEditEvent(meeting.id, { end: local('2026-11-23T14:45') }); // runs 45 min over

    const deferred = await engine.tick();
    expect(deferred.outcome).toBe('deferred'); // E8 debounce

    clock.advanceMin(2);
    const lockedBefore = google
      .tempoBlocks()
      .filter((b) => b.start < new Date(clock.now.getTime() + 60 * 60_000) && b.end > clock.now && !overlaps(b, { start: meeting.start, end: local('2026-11-23T14:45') }))
      .map((b) => `${b.id}@${b.start.toISOString()}`);
    const r = await engine.tick();
    expect(r.outcome).toBe('planned');
    assertPlanInvariants(google, clock.fn());
    // Non-conflicting blocks in the next hour are untouched.
    const lockedAfter = google.tempoBlocks().map((b) => `${b.id}@${b.start.toISOString()}`);
    for (const l of lockedBefore) expect(lockedAfter).toContain(l);
    // Moved blocks say why (E11).
    for (const c of r.applied) if (c.op === 'move') expect(c.reason ?? '').not.toBe('');
  });

  it('removes future blocks once the Google Task is checked off', async () => {
    const paper = google.addTask({ title: 'Read paper for seminar', due: local('2026-11-27T00:00') });
    await engine.tick({ force: true });
    expect(google.tempoBlocks().some((b) => b.tempo!.taskId === paper.id)).toBe(true);
    clock.advanceMin(5);
    google.completeTask(paper.id);
    clock.advanceMin(5);
    await engine.tick();
    expect(google.tempoBlocks().some((b) => b.tempo!.taskId === paper.id && b.start > clock.now)).toBe(false);
  });

  it('asks via invitation when a due date cannot be met, and applies the proposal on Yes', async () => {
    const thesis = google.addTask({ title: 'Thesis chapter draft', due: local('2026-11-24T00:00') });
    const r = await engine.tick({ force: true });
    expect(r.questionsOpened).toHaveLength(1); // E9: missed due date → exactly one invitation
    const q = r.questionsOpened[0]!;
    expect(q.title.startsWith('Tempo asks: ')).toBe(true);
    expect(q.description).toContain('Yes = apply');
    expect(invites.sent).toHaveLength(1);
    // The invitation is not treated as a busy fixed event.
    const inviteCopy = google.events.find((e) => e.id === q.inviteEventId)!;
    expect(isBusyFixedEvent(inviteCopy)).toBe(false);

    clock.advanceMin(5);
    invites.answer(q.inviteEventId!, 'accepted');
    clock.advanceMin(2);
    const r2 = await engine.tick();
    expect(r2.questionsClosed.map((x) => x.status)).toContain('yes');
    expect(invites.cancelled).toContain(q.inviteEventId);
    expect(google.tempoBlocks().some((b) => b.tempo!.taskId === thesis.id)).toBe(true);
    assertPlanInvariants(google, clock.fn());
    const state = await store.load();
    expect(state.questions.filter((x) => x.status === 'open')).toHaveLength(0);
  });

  it('treats an unanswered invitation as No and keeps the plan (D12)', async () => {
    google.addTask({ title: 'Thesis chapter draft', due: local('2026-11-24T00:00') });
    const r = await engine.tick({ force: true });
    const q = r.questionsOpened[0]!;
    clock.set(new Date(new Date(q.answerBy).getTime() + 60_000).toISOString());
    const r2 = await engine.tick();
    expect(r2.questionsClosed.map((x) => x.status)).toContain('expired');
    expect(invites.annotated.some((a) => a.id === q.inviteEventId)).toBe(true);
  });

  it('never sends invitations without an organizer account; questions expire safely', async () => {
    const noInvites = new TempoEngine({
      calendar: google,
      tasks: google,
      llm: stubLlm,
      store,
      config: { horizonDays: 7 },
      clock: clock.fn,
    });
    google.addTask({ title: 'Thesis chapter draft', due: local('2026-11-24T00:00') });
    const r = await noInvites.tick({ force: true });
    expect(r.questionsOpened).toHaveLength(0);
    const state = await store.load();
    expect(state.questions.every((q) => q.status !== 'open')).toBe(true);
  });
});
