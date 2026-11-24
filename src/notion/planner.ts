import { addMinutes, containsRange, durationMin, expandRange, formatLocal, localDayDiff, overlaps,
  roundUpToSlot, sameRange, subtractRanges, toLocal, workingWindows } from '../core/time.js';
import type { TimeRange } from '../core/types.js';
import { planningPreferences, type NotionSettings } from './settings.js';
import type { Task } from './tasks.js';

export const controls = ['Flexible', 'Pinned', 'Skip session'] as const;
export const actions = ['Use suggested time', 'Find another time', 'Leave unscheduled', 'Resume', 'Undo move'] as const;
export type Control = typeof controls[number];
export type Action = typeof actions[number];
export type SessionState = 'Planned' | 'Needs review' | 'Needs time' | 'Skipped' | 'History' | 'Closed';

export interface Session {
  key: string;
  taskId: string;
  parts?: number;
  title: string;
  url: string;
  state: SessionState;
  range?: TimeRange;
  published?: TimeRange;
  previous?: TimeRange;
  proposal?: TimeRange;
  override?: number;
  acceptedDeadline?: string;
  approvalRequired?: boolean;
  control: Control;
  publishedControl: Control;
  action?: Action;
  reason: string;
  estimate: string;
  reviewBy?: string;
  archived?: boolean;
  unreadableRange?: boolean;
  deadline?: string;
  recentMove?: string;
}

export function horizon(now: Date, config: NotionSettings): TimeRange {
  return { start: now, end: toLocal(now, config.timezone).startOf('day').plus({ days: config.horizonDays }).toJSDate() };
}

function slotIn(windows: TimeRange[], busy: TimeRange[], length: number, end: Date, after?: Date) {
  for (const window of subtractRanges(windows, busy)) {
    const start = roundUpToSlot(after && after > window.start ? after : window.start);
    const finish = addMinutes(start, length);
    if (finish <= window.end && finish <= end) return { start, end: finish };
  }
}

function order(a: Task, b: Task, now: Date) {
  const dueRank = (t: Task) => !t.due ? 2 : t.due <= now ? 3 : t.due <= addMinutes(now, 1440) ? 0 : 1;
  return dueRank(a) - dueRank(b) || (dueRank(a) === 0 ? +a.due! - +b.due! : b.priority - a.priority)
    || +(a.due ?? Infinity) - +(b.due ?? Infinity) || a.id.localeCompare(b.id);
}

export interface Work extends Task { key: string; part: number; parts: number }
const attempt = (key: string) => Number(key.split(':')[2] ?? 0);
function workItems(tasks: Task[], sessions: Session[], now: Date): Work[] {
  const existing = new Map<string, number>();
  for (const row of sessions) existing.set(row.taskId, Math.max(row.parts ?? 1, existing.get(row.taskId) ?? 1));
  const active = new Map<string, Session>();
  for (const row of sessions) {
    const [taskId, part = '1'] = row.key.split(':');
    const base = taskId + ':' + part;
    if (attempt(row.key) >= attempt(active.get(base)?.key ?? base)) active.set(base, row);
  }
  return tasks.flatMap(task => {
    // Long, divisible work uses balanced parts. Keep the established part identities across edits.
    const parts = existing.get(task.id) ?? (task.splittable && task.duration > 180 ? Math.ceil(task.duration / 120) : 1);
    const partDuration = Math.floor(task.duration / parts);
    return Array.from({ length: parts }, (_, index) => {
      const base = index ? task.id + ':' + (index + 1) : task.id + ':1';
      const row = active.get(base) ?? (index === 0 ? active.get(task.id) : undefined);
      const key = row?.range && row.action === 'Resume' && row.range.end <= now
        ? base + ':' + (attempt(row.key) + 1) : row?.key ?? (index ? base : task.id);
      return { ...task, key, part: index + 1, parts, duration: Math.max(1, partDuration + Number(index < task.duration % parts)) };
    });
  });
}

function normalize(row: Session, now: Date): Session {
  if (row.archived) return { ...row, range: undefined, control: 'Skip session', state: 'Skipped' };
  if (row.unreadableRange) return row;
  if (row.control === 'Skip session' || (!row.range && row.published)) {
    return { ...row, range: undefined, control: 'Skip session', state: 'Skipped', proposal: undefined,
      reason: 'Session skipped. Choose Resume to schedule this work again.' };
  }
  if (!row.range || row.range.end <= now || (row.published && sameRange(row.range, row.published))) return row;
  const moved = +row.range.start !== +(row.published?.start ?? Infinity);
  const resized = !row.published || durationMin(row.range) !== durationMin(row.published);
  return {
    ...row, control: moved && row.control === row.publishedControl ? 'Pinned' : row.control,
    override: resized ? Math.ceil(durationMin(row.range)) : row.override,
    reason: moved ? 'Time adjusted in Notion Calendar.' : 'Duration adjusted in Notion Calendar.',
  };
}

function initial(task: Work): Session {
  return { key: task.key, taskId: task.id, parts: task.parts, title: task.title, url: task.url, state: 'Needs time', estimate: '',
    reason: '', control: 'Flexible', publishedControl: 'Flexible' };
}

function finish(row: Session, task?: Work): Session {
  const deadline = task?.due?.toISOString();
  return { ...row, action: undefined, published: row.range, publishedControl: row.control,
    ...(task ? { parts: task.parts, title: task.title, url: task.url, deadline,
      estimate: row.override !== undefined ? `${row.override} min · adjusted` :
        `${task.duration} min${task.estimated ? ' · estimated' : ''}${task.parts > 1 ? ` · part ${task.part} of ${task.parts}` : ''}` } : {}) };
}

export function plan(tasks: Task[], rows: Session[], busy: TimeRange[], now: Date, config: NotionSettings): Session[] {
  const span = horizon(now, config);
  const windows = workingWindows(span, planningPreferences(config));
  const buffer = (range: TimeRange) => expandRange(range, config.bufferMinutes);
  const occupied = busy.map(buffer);
  const items = workItems(tasks, rows, now).sort((a, b) => order(a, b, now) || a.part - b.part);
  const itemByKey = new Map(items.map(t => [t.key, t]));
  const byKey = new Map(rows.map(row => [row.key, row]));
  const result = new Map<string, Session>();
  const latest = (item: Work) => byKey.get(item.key) ?? initial(item);
  const feasible = (r: TimeRange, cutoff: Date) => r.end <= cutoff &&
    windows.some(w => containsRange(w, r)) && !occupied.some(b => overlaps(r, b));
  const hasMoreTime = (item: Work) => rows.some(row => row.taskId === item.id &&
    row.key !== item.key && !row.archived && row.range && row.range.end > now);
  const pending: Array<{ work: Work; row: Session; previous?: TimeRange; forced: boolean }> = [];

  for (const row of rows) {
    if (itemByKey.has(row.key) || row.archived) continue;
    const historical = row.range && row.range.start < now;
    result.set(row.key, finish({ ...row, range: historical ? row.range : undefined,
      state: historical ? 'History' : 'Closed', proposal: undefined, reviewBy: undefined,
      reason: historical ? row.reason : 'The original task is complete, parked, or no longer available.' }));
  }

  const current = items.map(work => ({ work, row: normalize(latest(work), now) }));
  // Reserve explicit user choices and in-progress work before considering flexible time.
  for (const { work, row } of current) {
    if (row.unreadableRange && row.control !== 'Skip session' && row.action !== 'Leave unscheduled') {
      result.set(row.key, { ...row, state: 'Needs review', reason: 'Set a start and end time in Scheduled time.' });
      continue;
    }
    const r = row.range;
    if (!r || r.end <= now || (row.control !== 'Pinned' && r.start >= now) || row.action === 'Leave unscheduled') continue;
    const externalConflict = busy.some(b => overlaps(r, b));
    const pinConflict = current.some(other => other.row.key !== row.key && other.row.control === 'Pinned' &&
      other.row.range && overlaps(r, other.row.range));
    const late = work.due && r.end > work.due && row.acceptedDeadline !== work.due.toISOString();
    const beyondHours = r.start >= now && r.start < span.end &&
      !windows.some(w => containsRange(w, r));
    const reason = externalConflict ? 'This session overlaps a busy interval.' : pinConflict ? 'Two pinned sessions overlap.' :
      late ? 'This session ends after the task deadline.' : beyondHours ? 'This session falls outside working hours.' : undefined;
    occupied.push(buffer(r));
    result.set(row.key, finish({ ...row, state: reason ? 'Needs review' : 'Planned', reason: reason ?? row.reason,
      reviewBy: reason ? (work.due ?? r.start).toISOString() : undefined, proposal: undefined }, work));
  }

  // Protect feasible blocks first. A longer estimate can grow in place if the gap permits it.
  const flexible = current.filter(({ row }) => !result.has(row.key))
    .sort((a, b) => Number(!a.row.range) - Number(!b.row.range) ||
      Number(!(a.row.range && a.row.range.start < addMinutes(now, config.protectedMinutes))) -
      Number(!(b.row.range && b.row.range.start < addMinutes(now, config.protectedMinutes))) ||
      order(a.work, b.work, now) || a.work.part - b.work.part);
  for (const { work, row } of flexible) {
    const resume = row.action === 'Resume';
    const length = row.override ?? work.duration;
    if ((row.control === 'Skip session' && !resume) || row.action === 'Leave unscheduled') {
      result.set(row.key, finish({ ...row, archived: undefined, unreadableRange: undefined, range: undefined, state: 'Skipped', control: 'Skip session',
        reason: 'Left unscheduled. Choose Resume when you want to plan this work.', proposal: undefined, reviewBy: undefined }, work));
      continue;
    }
    if (row.range && row.range.end <= now && !resume) {
      const continuing = hasMoreTime(work);
      result.set(row.key, finish({ ...row, state: continuing ? 'History' : 'Needs review',
        reason: continuing ? row.reason : 'This session ended and the task is still open. Choose Resume if more time is needed.',
        reviewBy: continuing ? undefined : (work.due ?? row.range.end).toISOString() }, work));
      continue;
    }
    const normalized = resume ? { ...row, range: undefined, previous: undefined, approvalRequired: undefined, control: 'Flexible' as const } : row;
    const r = normalized.range;
    if (r && r.start >= span.end) {
      result.set(row.key, finish(normalized, work));
      if (r.start < addMinutes(span.end, config.bufferMinutes)) occupied.push(buffer(r));
      continue;
    }
    const accepted = work.due && normalized.acceptedDeadline === work.due.toISOString();
    const cutoff = accepted ? span.end : work.due ?? span.end;
    if (r) {
      const currentFits = feasible(r, cutoff);
      const candidate = durationMin(r) === length ? r : { start: r.start, end: addMinutes(r.start, length) };
      const growsIntoAnother = current.some(other => other.row.key !== row.key && other.row.range &&
        overlaps(candidate, buffer(other.row.range)));
      const mayUndo = normalized.action === 'Undo move' && normalized.previous && feasible(normalized.previous, cutoff);
      if (!mayUndo && (currentFits || (!growsIntoAnother && feasible(candidate, cutoff)))) {
        const picked = feasible(candidate, cutoff) && !growsIntoAnother ? candidate : r;
        occupied.push(buffer(picked));
        result.set(row.key, finish({ ...normalized, range: picked, state: 'Planned', proposal: undefined, reviewBy: undefined,
          reason: normalized.action === 'Undo move' ? 'The previous time is no longer available.' : normalized.reason }, work));
        continue;
      }
    }
    pending.push({ work, row: normalized, previous: r ?? normalized.previous, forced: Boolean(r) });
  }

  let moved = 0;
  const unresolved: typeof pending = [];
  pending.sort((a, b) => Number(!a.forced) - Number(!b.forced) || order(a.work, b.work, now) || a.work.part - b.work.part);
  for (const { work, row, previous, forced } of pending) {
    const length = row.override ?? work.duration;
    const accepted = work.due && row.acceptedDeadline === work.due.toISOString();
    const cutoff = accepted ? span.end : work.due ?? span.end;
    const approved = row.action === 'Use suggested time' && row.proposal && row.deadline === work.due?.toISOString() &&
      durationMin(row.proposal) === length && feasible(row.proposal, span.end) ? row.proposal : undefined;
    const undo = row.action === 'Undo move' && row.previous && feasible(row.previous, cutoff) ? row.previous : undefined;
    let chosen = approved || undo;
    let approvalRequired = row.approvalRequired || row.action === 'Find another time';
    if (!approvalRequired && !chosen && row.action !== 'Find another time' && row.action !== 'Use suggested time' && row.action !== 'Undo move') {
      const sameDay = previous ? windows.filter(w => localDayDiff(previous.start, w.start, config.timezone) === 0) : [];
      chosen = slotIn(sameDay, occupied, length, cutoff) ?? slotIn(windows, occupied, length, cutoff);
      const material = previous && chosen && (moved >= config.maxAutomaticMoves ||
        Math.abs(localDayDiff(previous.start, chosen.start, config.timezone)) > config.maxAutomaticMoveDays);
      if (material) {
        approvalRequired = true;
        chosen = undefined;
      }
      // If deadline-sensitive work has no open gap, try moving one less urgent block.
      if (!chosen && !approvalRequired && work.due && work.due <= span.end &&
          moved + Number(forced) < config.maxAutomaticMoves) {
        for (const other of result.values()) {
          const lower = itemByKey.get(other.key);
          if (!lower || !other.range || other.control !== 'Flexible' || other.state !== 'Planned' ||
              !latest(lower).range || !sameRange(other.range, latest(lower).range!) ||
              other.range.start < addMinutes(now, config.protectedMinutes) || order(work, lower, now) >= 0) continue;
          const oldBuffer = buffer(other.range);
          const index = occupied.findIndex(r => sameRange(r, oldBuffer));
          if (index < 0) continue;
          const without = occupied.filter((_, i) => i !== index);
          const rescueWindows = previous ? windows.filter(w =>
            Math.abs(localDayDiff(previous.start, w.start, config.timezone)) <= config.maxAutomaticMoveDays) : windows;
          const candidate = slotIn(rescueWindows, without, length, cutoff);
          if (!candidate) continue;
          const alternativeWindows = windows.filter(w => localDayDiff(other.range!.start, w.start, config.timezone) === 0);
          const alternative = slotIn(alternativeWindows, [...without, buffer(candidate)], durationMin(other.range), lower.due ?? span.end);
          if (!alternative) continue;
          occupied[index] = buffer(alternative);
          result.set(other.key, finish({ ...other, range: alternative, previous: other.range, recentMove: now.toISOString(),
            reason: `Moved from ${formatLocal(other.range.start, config.timezone)} to make room for an earlier deadline.` }, lower));
          moved++;
          chosen = candidate;
          break;
        }
      }
    }
    if (chosen) {
      occupied.push(buffer(chosen));
      if (forced && !approved && !undo) moved++;
      const late = work.due && chosen.end > work.due;
      const reason = late ? 'Scheduled after the deadline with your approval.' : undo ? 'Restored the previous time.' :
        previous ? `Moved from ${formatLocal(previous.start, config.timezone)} because the previous time no longer fit.` :
          work.due ? 'Placed in an available window before the deadline.' : 'Placed in an available work window.';
      result.set(row.key, finish({ ...row, range: chosen, state: 'Planned', reason,
        previous: undo ? undefined : previous, proposal: undefined, reviewBy: undefined,
        recentMove: previous ? now.toISOString() : row.recentMove,
        approvalRequired: undefined, acceptedDeadline: late ? work.due?.toISOString() : undefined }, work));
      continue;
    }
    unresolved.push({ work, row: { ...row, approvalRequired: approvalRequired || undefined }, previous, forced });
  }
  // Review suggestions use the final free windows, after real placements have been reserved.
  for (const { work, row, previous } of unresolved) {
    const length = row.override ?? work.duration;
    const nextStart = row.action === 'Find another time' && row.proposal ? row.proposal.end : undefined;
    const proposal = slotIn(windows, occupied, length, span.end, nextStart);
    const unavailable = row.action === 'Use suggested time' || row.action === 'Undo move';
    const reason = unavailable ? 'That time is no longer available. Review the current options.' :
      nextStart && !proposal ? 'There is no later opening in the planning window.' :
      row.approvalRequired ? 'Review this change before Tempo schedules the session.' : work.due ? 'No placement before the deadline fits the current plan.' :
        'No automatic placement fits the current plan.';
    const time = proposal ? ` Suggested time: ${formatLocal(proposal.start, config.timezone)}–${formatLocal(proposal.end, config.timezone, 'HH:mm')}.` : '';
    const stableReview = Boolean(row.proposal && row.deadline === work.due?.toISOString() &&
      durationMin(row.proposal) === length && feasible(row.proposal, span.end) && !row.action);
    const offered = stableReview ? row.proposal : proposal;
    result.set(row.key, finish({ ...row, range: undefined, previous, proposal: offered,
      state: offered || work.due || previous ? 'Needs review' : 'Needs time',
      reviewBy: offered ? (work.due && work.due > now && work.due < offered.start ? work.due : offered.start).toISOString() : work.due?.toISOString(),
      reason: stableReview ? row.reason : reason + time }, work));
  }
  return [...result.values()].sort((a, b) => a.key.localeCompare(b.key));
}
