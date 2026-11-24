import { describe, expect, it } from 'vitest';
import { plan, type Session } from '../../src/notion/planner.js';
import { readNotionSettings, type NotionSettings } from '../../src/notion/settings.js';
import { deadline, parseDuration, type Task } from '../../src/notion/tasks.js';

const now = new Date('2026-11-23T08:55:00Z');
const at = (start: string, end: string, day = '23') => ({
  start: new Date(`2026-11-${day}T${start}:00Z`), end: new Date(`2026-11-${day}T${end}:00Z`),
});
const config = await readNotionSettings('/nonexistent-tempo-test-settings.json');
const task = (id: string, opts: Partial<Task> = {}): Task => ({
  id, title: id, url: 'https://www.notion.so/' + id, duration: 45, estimated: false, priority: 3, ...opts,
});
function row(id: string, range = at('09:00', '09:45'), props: Partial<Session> = {}): Session {
  return { key: id, taskId: id, title: id, url: task(id).url, state: 'Planned', range, published: range,
    control: 'Flexible', publishedControl: 'Flexible', reason: '', estimate: '', ...props };
}

describe('Notion Calendar planner', () => {
  it('repairs the affected block and preserves a feasible existing session', () => {
    const old = [row('proposal'), row('invoices', at('10:00', '10:45'))];
    const items = [task('proposal', { due: new Date('2026-11-23T12:00:00Z') }), task('invoices')];
    const busy = [at('08:55', '09:45'), at('12:00', '12:45')];
    const result = plan(items, old, busy, now, config);
    expect(result.find(r => r.key === 'invoices')?.range).toEqual(old[1]?.range);
    expect(result.find(r => r.key === 'proposal')?.range).toEqual(at('10:50', '11:35'));
    expect(plan(items, result, busy, now, config)).toEqual(result);
  });

  it('moves one lower-priority block for a deadline when a simple repair works', () => {
    const stable = row('admin', at('10:00', '10:45'));
    const deadlineTask = task('client', { due: new Date('2026-11-23T10:45:00Z') });
    const result = plan([task('admin'), deadlineTask], [stable], [at('09:00', '09:55')], now, config);
    expect(result.find(r => r.key === 'client')?.range).toEqual(at('10:00', '10:45'));
    expect(result.find(r => r.key === 'admin')?.range).toEqual(at('10:50', '11:35'));
  });

  it('holds a material move for approval across polls', () => {
    const smallRepair: NotionSettings = { ...config, maxAutomaticMoveDays: 0 };
    const busy = [at('09:00', '19:00')];
    const first = plan([task('a')], [row('a')], busy, now, smallRepair)[0]!;
    expect(first).toMatchObject({ state: 'Needs review', approvalRequired: true });
    expect(first.range).toBeUndefined();
    expect(plan([task('a')], [first], busy, now, smallRepair)[0]?.range).toBeUndefined();
    const accepted = plan([task('a')], [{ ...first, action: 'Use suggested time' }], busy, now, smallRepair)[0]!;
    expect(accepted.range).toEqual(first.proposal);
  });

  it('offers only current openings and accepts lateness for the approved deadline', () => {
    const client = task('client', { due: new Date('2026-11-23T09:30:00Z') });
    const busy = [at('09:00', '10:00')];
    const result = plan([client, task('admin')], [], busy, now, config);
    const review = result.find(r => r.key === 'client')!;
    expect(review.range).toBeUndefined();
    expect(review.proposal).toEqual(at('10:55', '11:40'));
    const approved = plan([client, task('admin')], result.map(r =>
      r.key === 'client' ? { ...r, action: 'Use suggested time' } : r), busy, now, config);
    expect(approved.find(r => r.key === 'client')).toMatchObject({ state: 'Planned', range: review.proposal,
      acceptedDeadline: client.due!.toISOString() });
  });

  it('pins a drag, keeps an end-only correction flexible and preserves elapsed history', () => {
    const moved = row('manual', at('09:00', '09:45'), { range: at('10:00', '10:45') });
    const resized = row('resized', at('11:00', '11:45'), { range: at('11:00', '12:00') });
    const delta = plan([task('manual'), task('resized')], [moved, resized], [at('10:15', '10:20')], now, config);
    expect(delta.find(r => r.key === 'manual')).toMatchObject({ control: 'Pinned', range: moved.range, state: 'Needs review' });
    expect(delta.find(r => r.key === 'resized')).toMatchObject({ control: 'Flexible', range: resized.range, override: 60 });
    const elapsed = new Date('2026-11-23T10:50:00Z');
    const expired = plan([task('a')], [row('a')], [], elapsed, config)[0]!;
    expect(expired.state).toBe('Needs review');
    const resumed = plan([task('a')], [{ ...expired, action: 'Resume' }], [], elapsed, config);
    expect(resumed.find(r => r.key === 'a')).toMatchObject({ state: 'History', range: expired.range });
    expect(resumed.find(r => r.key === 'a:1:1')).toMatchObject({ state: 'Planned', range: at('10:50', '11:35') });
  });

  it('keeps split IDs across interrupted publishing and clears only future time on completion', () => {
    const items = [task('deep', { duration: 240, splittable: true })];
    const first = plan(items, [], [], now, config);
    expect(first.map(r => r.key)).toEqual(['deep', 'deep:2']);
    expect(plan(items, first.slice(0, 1), [], now, config).map(r => r.key)).toEqual(['deep', 'deep:2']);
    const complete = plan([], first, [], new Date('2026-11-23T11:02:00Z'), config);
    expect(complete.find(r => r.key === 'deep')).toMatchObject({ state: 'History', range: first[0]!.range });
    expect(complete.find(r => r.key === 'deep:2')?.range).toBeUndefined();
  });

  it('interprets duration formats and all-day deadlines in the configured timezone', () => {
    expect(parseDuration('1h 30m')).toBe(90);
    expect(parseDuration('1,5 Std.')).toBe(90);
    expect(parseDuration(47, 'hours')).toBe(2820);
    expect(parseDuration(-1)).toBeUndefined();
    expect(deadline({ start: '2026-03-30', end: null }, config)?.toISOString()).toBe('2026-03-30T18:00:00.000Z');
    expect(deadline({ start: '2026-11-30T13:30:00+01:00', end: null }, config)?.toISOString()).toBe('2026-11-30T12:30:00.000Z');
  });
});
