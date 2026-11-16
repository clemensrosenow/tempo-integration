/** Small helpers to read PlanOutput in behaviour tests. */
import { expect } from 'vitest';
import type { CalendarEvent, EventChange, PlanOutput, TimeRange } from '../../src/core/types.js';
import { local } from './fixtures.js';

export type Create = Extract<EventChange, { op: 'create' }>;
export type Move = Extract<EventChange, { op: 'move' }>;
export type Delete = Extract<EventChange, { op: 'delete' }>;

export function creates(changes: readonly EventChange[], taskId?: string): Create[] {
  return changes.filter((c): c is Create => c.op === 'create' && (!taskId || c.block.taskId === taskId));
}

export function moves(changes: readonly EventChange[], taskId?: string): Move[] {
  return changes.filter((c): c is Move => c.op === 'move' && (!taskId || c.taskId === taskId));
}

export function deletes(changes: readonly EventChange[], taskId?: string): Delete[] {
  return changes.filter((c): c is Delete => c.op === 'delete' && (!taskId || c.taskId === taskId));
}

export function target(c: EventChange): TimeRange | undefined {
  if (c.op === 'create') return { start: c.block.start, end: c.block.end };
  if (c.op === 'move') return c.to;
  return undefined;
}

/** "2026-11-16T10:00–11:00" */
export function show(r: TimeRange | undefined): string {
  if (!r) return '(none)';
  return `${local(r.start)}–${local(r.end).slice(11)}`;
}

export function reasonOf(c: EventChange): string | undefined {
  return c.op === 'create' ? c.block.reason : c.reason;
}

/** E7: no change ever refers to a non-Tempo event. */
export function expectFixedEventsUntouched(out: PlanOutput, events: readonly CalendarEvent[]): void {
  const fixedIds = new Set(events.filter((e) => !e.tempo).map((e) => e.id));
  for (const c of out.apply) {
    if (c.op !== 'create') expect(fixedIds.has(c.eventId), `change touches fixed event ${c.eventId}`).toBe(false);
  }
}

/** E8: nothing is created in / moved into the next hour. */
export function expectNothingIntoLockWindow(out: PlanOutput, now: Date): void {
  const lock = now.getTime() + 60 * 60_000;
  for (const c of out.apply) {
    const t = target(c);
    if (!t) continue;
    const userKept = c.op === 'move' && c.from.start.getTime() === c.to.start.getTime() && c.from.end.getTime() === c.to.end.getTime();
    if (userKept) continue;
    expect(t.start.getTime(), `change ${c.op} lands in lock window at ${local(t.start)}`).toBeGreaterThanOrEqual(lock);
  }
}

/** Every applied change carries a one-line reason (E11). */
export function expectReasons(out: PlanOutput): void {
  for (const c of out.apply) expect(reasonOf(c), `${c.op} without reason`).toBeTruthy();
}
