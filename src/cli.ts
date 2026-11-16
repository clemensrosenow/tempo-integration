#!/usr/bin/env node
/**
 * Tempo command line — headless operation of the integration (no UI).
 *
 *   tempo login [--organizer]     connect the student account / the Tempo organizer account
 *   tempo logout [--organizer]
 *   tempo setup [--yes] [--working-hours 09:00-18:00] [--days 1,2,3,4,5]
 *               [--focus 09:00-12:00] [--sleep 23:00-07:00] [--calendars id1,id2] [--timezone Europe/Berlin]
 *   tempo plan [--force]          run one planning tick
 *   tempo run                     keep planning (polling + optional calendar push webhook)
 *   tempo status                  preferences, questions, learned notes, upcoming blocks
 *   tempo tasks | calendars       debug views of what Tempo reads from Google
 *   tempo clear-blocks            delete all future Tempo blocks (keeps preferences)
 */
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { DateTime } from 'luxon';
import { loadConfig } from './config.js';
import { createGoogleAdapters, isInvalidGrant, signIn, signOut } from './google/index.js';
import { createLlm } from './llm/index.js';
import { FileStateStore } from './store/fileStore.js';
import { TempoEngine, errorMessage, type TickReport } from './engine/engine.js';
import { confirmSetup, describeProposal, proposeSetup, type SetupOverrides } from './engine/setup.js';
import { startDaemon } from './engine/daemon.js';
import type { DailyWindow, IsoWeekday } from './core/types.js';

async function main(argv: string[]): Promise<void> {
  const [command = 'help', ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      organizer: { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      force: { type: 'boolean', default: false },
      'no-browser': { type: 'boolean', default: false },
      'working-hours': { type: 'string' },
      days: { type: 'string' },
      focus: { type: 'string' },
      sleep: { type: 'string' },
      calendars: { type: 'string' },
      timezone: { type: 'string' },
    },
  });

  const config = loadConfig();
  for (const w of config.warnings) console.warn(`tempo: warning: ${w}`);
  const store = new FileStateStore(config.dataDir);
  const log = (line: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);

  const adapters = async () => {
    const state = await store.load();
    return createGoogleAdapters({
      dataDir: config.dataDir,
      timezone: state.prefs?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      syncTokens: {
        get: (calendarId: string) => state.syncTokens[calendarId],
        set: (calendarId: string, token: string) => {
          state.syncTokens[calendarId] = token;
        },
      },
    });
  };

  const engine = async () => {
    const g = await adapters();
    if (!g.invites) log('note: no organizer account connected — questions cannot be sent (run `tempo login --organizer`)');
    return new TempoEngine({
      calendar: g.calendar,
      tasks: g.tasks,
      invites: g.invites,
      llm: createLlm(config.llm, { log }),
      store,
      config: { horizonDays: config.horizonDays, debounceMs: config.debounceMs },
      log,
    });
  };

  switch (command) {
    case 'login': {
      const profile = values.organizer ? 'organizer' : 'user';
      const { email } = await signIn(profile, { dataDir: config.dataDir, openBrowser: !values['no-browser'], log });
      log(`connected ${profile} account ${email}`);
      if (profile === 'user') log('next: `tempo setup`');
      return;
    }
    case 'logout': {
      const profile = values.organizer ? 'organizer' : 'user';
      await signOut(profile, config.dataDir);
      log(`disconnected ${profile} account`);
      return;
    }
    case 'setup': {
      const g = await adapters();
      const overrides: SetupOverrides = {
        workingHours: parseWindow(values['working-hours']),
        workingDays: parseDays(values.days),
        focusTime: parseWindow(values.focus),
        sleep: parseWindow(values.sleep),
        calendarIds: values.calendars?.split(',').map((s) => s.trim()).filter(Boolean),
        timezone: values.timezone,
      };
      const proposal = await proposeSetup(g.calendar, new Date(), overrides);
      console.log(describeProposal(proposal));
      if (!values.yes && !(await confirm('\nUse these settings? [Y/n] '))) {
        console.log('Nothing saved. Re-run with overrides, e.g. --working-hours 08:00-17:00');
        return;
      }
      const { tempoCalendarId } = await confirmSetup(g.calendar, store, proposal);
      log(`saved. Tempo calendar: ${tempoCalendarId}`);
      log('drafting your first plan …');
      printReport(await (await engine()).tick({ force: true }));
      return;
    }
    case 'plan':
    case 'tick': {
      printReport(await (await engine()).tick({ force: values.force }));
      return;
    }
    case 'run': {
      const e = await engine();
      const g = await adapters();
      const state = await store.load();
      await startDaemon({
        engine: e,
        pollIntervalSec: config.pollIntervalSec,
        webhook: config.webhook,
        calendarIds: [...(state.prefs?.selectedCalendarIds ?? []), state.tempoCalendarId].filter(
          (id): id is string => Boolean(id),
        ),
        watch: g.watch,
        store,
        log,
        describeError,
      });
      return;
    }
    case 'status': {
      const state = await store.load();
      if (!state.prefs) {
        console.log('Not set up. Run `tempo login` then `tempo setup`.');
        return;
      }
      const tz = state.prefs.timezone;
      const fmt = (d: Date | string) => DateTime.fromJSDate(new Date(d)).setZone(tz).toFormat('ccc dd LLL HH:mm');
      console.log(`Account: ${state.userEmail}   Tempo calendar: ${state.tempoCalendarId}`);
      console.log(
        `Working hours ${state.prefs.workingHours.start}–${state.prefs.workingHours.end}, focus ${state.prefs.focusTime.start}–${state.prefs.focusTime.end}, sleep ${state.prefs.sleep.start}–${state.prefs.sleep.end} (${tz})`,
      );
      console.log(`Last plan: ${state.lastPlanAt ? fmt(state.lastPlanAt) : 'never'}`);
      const open = state.questions.filter((q) => q.status === 'open' || q.status === 'queued');
      console.log(`\nQuestions (${open.length}):`);
      for (const q of open) console.log(`  [${q.status}] ${q.title} @ ${fmt(q.slot.start)} (answer by ${fmt(q.answerBy)})`);
      console.log(`\nLearned (duration scale ${state.prefs.learned.durationScale.toFixed(2)}):`);
      for (const n of state.prefs.learned.notes.slice(-10)) console.log(`  - ${n}`);
      if (state.tempoCalendarId) {
        const g = await adapters();
        const now = new Date();
        const blocks = await g.calendar.listEvents([state.tempoCalendarId], {
          start: now,
          end: new Date(now.getTime() + 7 * 86_400_000),
        });
        console.log(`\nUpcoming Tempo blocks (7 days):`);
        for (const b of blocks.filter((b) => b.tempo?.kind === 'block')) {
          console.log(`  ${fmt(b.start)}–${DateTime.fromJSDate(b.end).setZone(tz).toFormat('HH:mm')}  ${b.title}`);
        }
      }
      return;
    }
    case 'tasks': {
      const g = await adapters();
      for (const t of await g.tasks.listTasks({ completedSinceDays: 7 })) {
        console.log(
          `${t.status === 'completed' ? '[x]' : '[ ]'} ${t.parentId ? '   ↳ ' : ''}${t.title}${t.due ? `  (due ${t.due.toISOString().slice(0, 10)})` : ''}  ${t.listId}/${t.id}`,
        );
      }
      return;
    }
    case 'calendars': {
      const g = await adapters();
      for (const c of await g.calendar.listCalendars()) {
        console.log(`${c.primary ? '*' : ' '} ${c.isTempo ? '[Tempo] ' : ''}${c.summary}  (${c.accessRole})  ${c.id}`);
      }
      return;
    }
    case 'clear-blocks': {
      const state = await store.load();
      if (!state.tempoCalendarId) throw new Error('Not set up.');
      const g = await adapters();
      const now = new Date();
      const blocks = await g.calendar.listEvents([state.tempoCalendarId], {
        start: now,
        end: new Date(now.getTime() + 365 * 86_400_000),
      });
      for (const b of blocks.filter((b) => b.tempo && b.start > now)) await g.calendar.deleteBlock(state.tempoCalendarId, b.id);
      delete state.lastSnapshot;
      await store.save(state);
      log(`deleted ${blocks.length} future Tempo block(s)`);
      return;
    }
    default:
      console.log(
        [
          'Usage: tempo <command>',
          '  login [--organizer] [--no-browser]   connect Google (student account / Tempo organizer account)',
          '  logout [--organizer]',
          '  setup [--yes] [--working-hours HH:mm-HH:mm] [--days 1,2,3,4,5] [--focus HH:mm-HH:mm]',
          '        [--sleep HH:mm-HH:mm] [--calendars id1,id2] [--timezone Area/City]',
          '  plan [--force]                       run one planning tick',
          '  run                                  keep planning in the background',
          '  status | tasks | calendars           inspect state',
          '  clear-blocks                         delete future Tempo blocks',
        ].join('\n'),
      );
  }
}

function parseWindow(v: string | undefined): DailyWindow | undefined {
  if (!v) return undefined;
  const m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(v.trim());
  if (!m) throw new Error(`Expected HH:mm-HH:mm, got "${v}"`);
  const pad = (s: string) => s.padStart(5, '0');
  return { start: pad(m[1]!), end: pad(m[2]!) };
}

function parseDays(v: string | undefined): IsoWeekday[] | undefined {
  if (!v) return undefined;
  const days = v.split(',').map((s) => Number(s.trim()));
  if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) throw new Error(`--days expects 1..7 (Mon..Sun), got "${v}"`);
  return days as IsoWeekday[];
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

function printReport(r: TickReport): void {
  console.log(`\n${r.outcome.toUpperCase()} — signals: ${r.signals.map((s) => s.type).join(', ') || 'none'}`);
  for (const c of r.applied) {
    if (c.op === 'create') console.log(`  + ${c.block.title}  ${c.block.start.toISOString()} → ${c.block.end.toISOString()}  ${c.block.reason ?? ''}`);
    else if (c.op === 'move') console.log(`  ~ ${c.taskId}  → ${c.to.start.toISOString()}  ${c.reason ?? ''}`);
    else console.log(`  - ${c.taskId}  ${c.reason ?? ''}`);
  }
  for (const f of r.failed) console.log(`  ! ${f.change.op} failed: ${f.error}`);
  for (const q of r.questionsOpened) console.log(`  ? ${q.title}`);
}

function describeError(err: unknown): string {
  if (isInvalidGrant(err)) {
    return (
      'Google sign-in expired or was revoked (apps in OAuth "testing" mode get 7-day tokens). ' +
      'Run `npm run tempo -- login` (and `npm run tempo -- login --organizer`) again.'
    );
  }
  return errorMessage(err);
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(`tempo: ${describeError(err)}`);
  process.exitCode = 1;
});
