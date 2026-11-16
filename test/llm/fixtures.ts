import type { ExplainRequest, PlaceRequest, UnderstandRequest } from '../../src/core/ports.js';

export const now = new Date('2026-11-16T09:00:00+01:00');
export const tz = 'Europe/Berlin';

export const understandReq: UnderstandRequest = {
  now,
  timezone: tz,
  learnedNotes: ['Writing tasks take you ~1.5x longer'],
  tasks: [
    { id: 't1', title: 'Write essay', due: new Date('2026-11-20T00:00:00+01:00') },
    { id: 't2', title: 'Call dentist' },
  ],
};

export const placeReq: PlaceRequest = {
  now,
  timezone: tz,
  focusTime: { start: '09:00', end: '12:00' },
  learnedNotes: [],
  gaps: [{ start: new Date('2026-11-16T10:00:00+01:00'), end: new Date('2026-11-16T13:00:00+01:00') }],
  currentBlocks: [],
  tasks: [
    { taskId: 't1', title: 'Write essay', durationMin: 120, minChunkMin: 60, priority: 4, urgency: 3, deepWork: true },
  ],
};

export const explainReq: ExplainRequest = {
  now,
  timezone: tz,
  changes: [
    { taskId: 't1', title: 'Write essay', kind: 'moved', cause: "fixed event 'Project meeting' extended by 45 min" },
    { taskId: 't2', title: 'Call dentist', kind: 'created', cause: 'new task' },
  ],
};

export const goodUnderstandJson = JSON.stringify({
  estimates: [
    { taskId: 't1', durationMin: 200, priority: 4, urgency: 3, confidence: 0.9, minChunkMin: 60, deepWork: true, rationale: 'essay' },
    { taskId: 't2', durationMin: 10, priority: 2, urgency: 2, confidence: 0.8, minChunkMin: 10, deepWork: false, rationale: 'call' },
    { taskId: 'unknown', durationMin: 10, priority: 2, urgency: 2, confidence: 0.8, minChunkMin: 10, deepWork: false, rationale: '' },
  ],
});

export const goodPlaceJson = JSON.stringify({
  placements: [{ taskId: 't1', start: '2026-11-16T10:00:00+01:00', end: '2026-11-16T12:00:00+01:00' }],
});

export const goodExplainJson = JSON.stringify({
  reasons: [{ taskId: 't1', reason: 'Your project meeting ran 45 min over, so the essay moved to 15:00' }],
});

/** Collects log lines instead of printing them. */
export function logSink(): { lines: string[]; log: (m: string) => void } {
  const lines: string[] = [];
  return { lines, log: (m) => lines.push(m) };
}
