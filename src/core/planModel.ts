/**
 * Internal planning model shared by the core modules (not part of the
 * cross-module contract in types.ts / ports.ts).
 */
import type { TimeRange } from './types.js';

/** One unit of work the placer has to schedule (an open task or an open subtask). */
export interface PlanItem {
  taskId: string;
  taskListId: string;
  title: string;
  /** Minutes still to be placed in movable blocks (pinned/locked blocks already subtracted). */
  needMin: number;
  minChunkMin: number;
  /** 1..5 (learned priority already applied). */
  priority: number;
  /** 1..5 */
  urgency: number;
  deepWork: boolean;
  /** Exclusive deadline (end of the local due day). Subtasks inherit the parent's due. */
  due?: Date;
  /** Subtasks of one parent share an orderGroup (= parent id) and are placed by orderIndex. */
  orderGroup?: string;
  orderIndex?: number;
  /**
   * Lateness already accepted: the task's current blocks already end after its
   * due (e.g. the user said Yes to a "1 day late" question). Late blocks are then
   * kept and no new missed-due question is raised.
   */
  lateOk: boolean;
  /** Ranges this task must not be placed in during this run (e.g. a block the user deleted). */
  avoid: TimeRange[];
}

/** A block of a task at a concrete time (current calendar block or placement). */
export interface TaskBlock {
  taskId: string;
  start: Date;
  end: Date;
  /** Present for blocks that exist in the Tempo calendar. */
  eventId?: string;
}

/**
 * A current Tempo block in the calendar, classified for this run.
 * - past:     ended (end <= now) — never touched, counts as worked time
 * - pinned:   stays where it is this run (lock window, user just moved it,
 *             frozen by the open question, kept after a "No", just created by an answer)
 * - movable:  may be kept, moved or deleted by the planner
 */
export interface CurrentBlock {
  eventId: string;
  taskId: string;
  taskListId: string;
  title: string;
  start: Date;
  end: Date;
  part?: number;
  status: 'past' | 'pinned' | 'movable';
  /** Why the block is pinned (debug only). */
  pinReason?: string;
}

/** One candidate placement for a single task (used for question options). */
export interface PlacementOption {
  blocks: TimeRange[];
  /** Minutes that did not fit at all. */
  unplacedMin: number;
}
