import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TempoState } from '../../src/core/ports.js';
import type { Question } from '../../src/core/types.js';
import { emptyLearned } from '../../src/core/types.js';
import { defaultState, FileStateStore } from '../../src/store/fileStore.js';
import { MemoryStateStore } from '../../src/store/memoryStore.js';

const d = (iso: string): Date => new Date(iso);

function question(): Question {
  return {
    id: 'q1',
    kind: 'missed-due',
    title: 'Tempo asks: Finish essay 1 day late?',
    description: 'Yes = apply · No = keep as is · Maybe = other time',
    slot: { start: d('2026-11-20T14:00:00Z'), end: d('2026-11-20T16:00:00Z') },
    taskId: 't1',
    taskListId: 'l1',
    proposal: [
      {
        op: 'create',
        block: { taskId: 't1', taskListId: 'l1', title: 'Essay', start: d('2026-11-20T14:00:00Z'), end: d('2026-11-20T16:00:00Z') },
      },
      {
        op: 'move',
        eventId: 'ev1',
        taskId: 't2',
        from: { start: d('2026-11-19T09:00:00Z'), end: d('2026-11-19T10:00:00Z') },
        to: { start: d('2026-11-21T09:00:00Z'), end: d('2026-11-21T10:00:00Z') },
        reason: 'Made room for the essay',
      },
      { op: 'delete', eventId: 'ev2', taskId: 't3' },
    ],
    alternatives: [
      {
        slot: { start: d('2026-11-21T10:00:00Z'), end: d('2026-11-21T12:00:00Z') },
        proposal: [
          {
            op: 'create',
            block: { taskId: 't1', taskListId: 'l1', title: 'Essay', start: d('2026-11-21T10:00:00Z'), end: d('2026-11-21T12:00:00Z') },
          },
        ],
        summary: 'Saturday morning',
      },
    ],
    replacedBlocks: [
      { taskId: 't1', taskListId: 'l1', title: 'Essay', start: d('2026-11-19T14:00:00Z'), end: d('2026-11-19T15:00:00Z'), part: 0 },
    ],
    replacedEventIds: ['ev3'],
    createdAt: d('2026-11-16T08:00:00Z'),
    answerBy: d('2026-11-20T13:00:00Z'),
    status: 'open',
    inviteEventId: 'inv1',
  };
}

function fullState(): TempoState {
  return {
    ...defaultState(),
    prefs: {
      timezone: 'Europe/Berlin',
      workingHours: { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] },
      focusTime: { start: '09:00', end: '12:00' },
      sleep: { start: '23:00', end: '07:00' },
      selectedCalendarIds: ['me@example.com'],
      bufferMin: 5,
      learned: { ...emptyLearned(), hourAffinity: { 9: 1.5 } },
    },
    userEmail: 'me@example.com',
    tempoCalendarId: 'tempo@group.calendar.google.com',
    estimates: {
      t1: { taskId: 't1', durationMin: 120, priority: 4, urgency: 3, confidence: 0.8, minChunkMin: 60, deepWork: true, estimatedAt: '2026-11-16T08:00:00.000Z' },
    },
    questions: [question()],
    lastSnapshot: {
      takenAt: '2026-11-16T08:00:00.000Z',
      events: [{ id: 'e1', calendarId: 'c', start: '2026-11-16T09:00:00.000Z', end: '2026-11-16T10:00:00.000Z', status: 'confirmed', transparency: 'opaque', updated: '2026-11-15T00:00:00.000Z' }],
      tasks: [{ id: 't1', status: 'needsAction', updated: '2026-11-15T00:00:00.000Z', title: 'Essay' }],
    },
    syncTokens: { 'me@example.com': 'tok' },
  };
}

describe('FileStateStore', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tempo-store-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns the default state when no file exists', async () => {
    const store = new FileStateStore(path.join(dir, 'missing'));
    expect(await store.load()).toEqual(defaultState());
  });

  it('round-trips a Question with all its Dates', async () => {
    const store = new FileStateStore(path.join(dir, 'data'));
    const state = fullState();
    await store.save(state);
    const loaded = await store.load();
    expect(loaded).toEqual(state);

    const q = loaded.questions[0];
    expect(q?.slot.start).toBeInstanceOf(Date);
    expect(q?.createdAt).toBeInstanceOf(Date);
    expect(q?.answerBy.toISOString()).toBe('2026-11-20T13:00:00.000Z');
    const move = q?.proposal[1];
    expect(move?.op === 'move' && move.to.start instanceof Date).toBe(true);
    expect(q?.alternatives[0]?.slot.end).toBeInstanceOf(Date);
    expect(q?.replacedBlocks[0]?.start).toBeInstanceOf(Date);
    // String-typed timestamps stay strings.
    expect(typeof loaded.estimates.t1?.estimatedAt).toBe('string');
    expect(typeof loaded.lastSnapshot?.events[0]?.start).toBe('string');
    expect(loaded.prefs?.learned.hourAffinity[9]).toBe(1.5);
  });

  it('writes atomically with mode 0600 and leaves no temp files', async () => {
    const store = new FileStateStore(dir);
    await Promise.all([store.save(fullState()), store.save({ ...fullState(), userEmail: 'last@example.com' })]);
    const files = await fs.readdir(dir);
    expect(files).toEqual(['state.json']);
    const stat = await fs.stat(path.join(dir, 'state.json'));
    expect(stat.mode & 0o777).toBe(0o600);
    expect((await store.load()).userEmail).toBe('last@example.com');
  });

  it('rejects unknown schema versions and corrupt files', async () => {
    const store = new FileStateStore(dir);
    await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ version: 2 }));
    await expect(store.load()).rejects.toThrow(/Unsupported Tempo state version/);
    await fs.writeFile(path.join(dir, 'state.json'), '{not json');
    await expect(store.load()).rejects.toThrow(/Cannot read/);
  });

  it('fills fields missing from older files with defaults', async () => {
    await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ version: 1, userEmail: 'a@b.c' }));
    const loaded = await new FileStateStore(dir).load();
    expect(loaded).toEqual({ ...defaultState(), userEmail: 'a@b.c' });
  });
});

describe('MemoryStateStore', () => {
  it('stores isolated copies and keeps Dates', async () => {
    const store = new MemoryStateStore();
    const state = fullState();
    await store.save(state);
    state.userEmail = 'mutated@example.com';
    const loaded = await store.load();
    expect(loaded.userEmail).toBe('me@example.com');
    expect(loaded.questions[0]?.slot.start).toBeInstanceOf(Date);
    expect(store.saves).toBe(1);
  });
});
