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
 *   tempo prefs [hours|focus|sleep|buffer|timezone …]   show / change tempo.json
 *   tempo calendars [add|remove|reset …]                busy calendars (tempo.json)
 *   tempo tasks                   debug view of what Tempo reads from Google Tasks
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
import type { CalendarInfo, DailyWindow, IsoWeekday } from './core/types.js';
import {
  readSettings,
  settingsFromPrefs,
  SettingsStore,
  WEEKDAYS,
  writeSettings,
  type SettingsFile,
  type WeekdayKey,
} from './settings/settings.js';

async function main(argv: string[]): Promise<void> {
  const [command = 'help', ...rest] = argv;
  const { values, positionals } = parseArgs({
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
  const log = (line: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
  const store = new SettingsStore(new FileStateStore(config.dataDir), config.settingsFile, log);

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
    const state = await store.load();
    if (state.userEmail && g.userEmail && state.userEmail !== g.userEmail) {
      throw new Error(
        `Signed in as ${g.userEmail}, but Tempo was set up for ${state.userEmail}. Run \`tempo setup\` to start over with this account.`,
      );
    }
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
      const { tempoCalendarId, accountChanged } = await confirmSetup(g.calendar, store, proposal, {
        settingsFile: config.settingsFile,
      });
      if (accountChanged) log('new Google account: started from a clean slate');
      log(`saved. Tempo calendar: ${tempoCalendarId}`);
      log(`settings: ${config.settingsFile} (edit it, or use \`tempo prefs\` / \`tempo calendars\`)`);
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
      console.log(describeSettings(settingsFromPrefs(state.prefs)));
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
    case 'prefs': {
      const { settings, state } = await loadSettingsOrFail(store, config.settingsFile);
      const [what, ...args] = positionals;
      if (what) {
        changeSetting(settings, what, args);
        await writeSettings(config.settingsFile, settings);
        log(`saved ${config.settingsFile}${state ? ' — a running Tempo re-plans on its next tick' : ''}`);
      }
      console.log(describeSettings(settings));
      if (!what) console.log(`\nFile: ${config.settingsFile}\nChange: tempo prefs hours mon-fri 09:00-18:00 | hours sat off | focus 09:00-12:00 | sleep 23:30-07:00 | buffer 10 | timezone Europe/Berlin`);
      return;
    }
    case 'calendars': {
      const g = await adapters();
      const calendars = await g.calendar.listCalendars();
      const [action, ...args] = positionals;
      const loaded = await loadSettingsOrFail(store, config.settingsFile).catch(() => undefined);
      if (action) {
        if (!loaded) throw new Error('Not set up. Run `tempo setup` first.');
        const { settings } = loaded;
        const busy = new Map(settings.busyCalendars.map((c) => [c.id, c]));
        if (action === 'reset') {
          busy.clear();
          for (const c of calendars) if (c.visible && !c.isTempo) busy.set(c.id, { name: c.summary, id: c.id });
        } else if (action === 'add' || action === 'remove') {
          if (args.length === 0) throw new Error(`Usage: tempo calendars ${action} <name or id> [...]`);
          for (const arg of args) {
            const c = findCalendar(calendars, arg);
            if (c.isTempo) throw new Error('The Tempo calendar is always read; it cannot be added or removed.');
            if (action === 'add') busy.set(c.id, { name: c.summary, id: c.id });
            else busy.delete(c.id);
          }
        } else {
          throw new Error(`Unknown action "${action}". Use: tempo calendars [add|remove <name>… | reset]`);
        }
        settings.busyCalendars = [...busy.values()];
        await writeSettings(config.settingsFile, settings);
        log(`saved ${config.settingsFile}`);
      }
      const busyIds = new Set((loaded?.settings.busyCalendars ?? []).map((c) => c.id));
      console.log('Calendars (x = read as busy time; "hidden" = unchecked in Google Calendar):');
      for (const c of calendars) {
        const mark = c.isTempo ? 'T' : busyIds.has(c.id) ? 'x' : ' ';
        console.log(`  [${mark}] ${c.summary}${c.primary ? ' (primary)' : ''}${c.visible === false ? '  — hidden' : ''}${c.isTempo ? '  — Tempo writes here' : ''}`);
      }
      const gone = [...busyIds].filter((id) => !calendars.some((c) => c.id === id));
      for (const id of gone) console.log(`  [x] ${id}  — no longer in your calendar list`);
      if (!action) console.log('\nChange: tempo calendars add "<name>" | remove "<name>" | reset (= the ones checked in Google Calendar)');
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
          '  setup [--yes] [--working-hours HH:mm-HH:mm] [--days mon-fri] [--focus HH:mm-HH:mm]',
          '        [--sleep HH:mm-HH:mm] [--calendars id1,id2] [--timezone Area/City]',
          '  plan [--force]                       run one planning tick',
          '  run                                  keep planning in the background',
          '  status | tasks                       inspect state',
          '  prefs [hours <days> <HH:mm-HH:mm|off> | focus … | sleep … | buffer <min> | timezone <tz>]',
          '  calendars [add <name>… | remove <name>… | reset]   which calendars count as busy',
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
  return parseDaySpec(v).map((k) => (WEEKDAYS.indexOf(k) + 1) as IsoWeekday);
}

/** "mon-fri", "sat,sun", "weekdays", "weekend", "all", "1,2,3" → weekday keys. */
export function parseDaySpec(spec: string): WeekdayKey[] {
  const out = new Set<WeekdayKey>();
  const key = (t: string): WeekdayKey => {
    const n = Number(t);
    if (Number.isInteger(n) && n >= 1 && n <= 7) return WEEKDAYS[n - 1]!;
    const k = WEEKDAYS.find((d) => t.toLowerCase().startsWith(d));
    if (!k) throw new Error(`Unknown day "${t}" (use mon…sun, mon-fri, weekdays, weekend, all)`);
    return k;
  };
  for (const part of spec.split(',').map((p) => p.trim()).filter(Boolean)) {
    const p = part.toLowerCase();
    if (p === 'all' || p === 'daily') WEEKDAYS.forEach((d) => out.add(d));
    else if (p === 'weekdays') WEEKDAYS.slice(0, 5).forEach((d) => out.add(d));
    else if (p === 'weekend' || p === 'weekends') WEEKDAYS.slice(5).forEach((d) => out.add(d));
    else if (p.includes('-')) {
      const [a, b] = p.split('-').map((x) => WEEKDAYS.indexOf(key(x.trim())));
      for (let i = a!; ; i = (i + 1) % 7) {
        out.add(WEEKDAYS[i]!);
        if (i === b) break;
      }
    } else out.add(key(p));
  }
  if (out.size === 0) throw new Error(`No days in "${spec}"`);
  return [...out];
}

async function loadSettingsOrFail(
  store: SettingsStore,
  file: string,
): Promise<{ settings: SettingsFile; state: boolean }> {
  const r = await readSettings(file);
  if (r.kind === 'ok') return { settings: r.settings, state: true };
  if (r.kind === 'invalid') throw new Error(`${r.error}\nFix the file (or delete it to regenerate it from the last valid settings).`);
  const state = await store.load();
  if (!state.prefs) throw new Error('Not set up. Run `tempo login` then `tempo setup`.');
  // Recreate the file from the settings saved at setup.
  const settings = settingsFromPrefs(state.prefs);
  await writeSettings(file, settings);
  return { settings, state: true };
}

function changeSetting(s: SettingsFile, what: string, args: string[]): void {
  const one = (name: string) => {
    if (args.length !== 1) throw new Error(`Usage: tempo prefs ${what} <${name}>`);
    return args[0]!;
  };
  const win = (v: string) => {
    const w = parseWindow(v);
    if (!w) throw new Error(`Expected HH:mm-HH:mm, got "${v}"`);
    return `${w.start}-${w.end}`;
  };
  switch (what) {
    case 'hours': {
      if (args.length !== 2) throw new Error('Usage: tempo prefs hours <mon-fri|sat,sun|…> <HH:mm-HH:mm|off>');
      const value = args[1]!.toLowerCase() === 'off' ? 'off' : win(args[1]!);
      for (const d of parseDaySpec(args[0]!)) s.workingHours[d] = value;
      return;
    }
    case 'focus':
      s.focusTime = win(one('HH:mm-HH:mm'));
      return;
    case 'sleep':
      s.sleep = win(one('HH:mm-HH:mm'));
      return;
    case 'buffer': {
      const n = Number(one('minutes'));
      if (!Number.isInteger(n) || n < 0 || n > 60) throw new Error('Buffer must be 0-60 minutes');
      s.bufferMinutes = n;
      return;
    }
    case 'timezone':
      s.timezone = one('Area/City');
      return;
    default:
      throw new Error(`Unknown setting "${what}". Use: hours | focus | sleep | buffer | timezone`);
  }
}

function describeSettings(s: SettingsFile): string {
  const label: Record<WeekdayKey, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
  // Group consecutive days with the same hours: "Mon–Thu 09:00-18:00".
  const groups: string[] = [];
  let i = 0;
  while (i < 7) {
    let j = i;
    while (j + 1 < 7 && s.workingHours[WEEKDAYS[j + 1]!] === s.workingHours[WEEKDAYS[i]!]) j++;
    const days = i === j ? label[WEEKDAYS[i]!] : `${label[WEEKDAYS[i]!]}–${label[WEEKDAYS[j]!]}`;
    groups.push(`${days} ${s.workingHours[WEEKDAYS[i]!]}`);
    i = j + 1;
  }
  return [
    `Working hours:  ${groups.join(', ')}`,
    `Focus time:     ${s.focusTime}`,
    `Sleep:          ${s.sleep}`,
    `Buffer:         ${s.bufferMinutes} min around fixed events`,
    `Timezone:       ${s.timezone}`,
    `Busy calendars: ${s.busyCalendars.map((c) => c.name ?? c.id).join(', ') || 'none'}`,
  ].join('\n');
}

function findCalendar(calendars: CalendarInfo[], query: string): CalendarInfo {
  const exact = calendars.filter((c) => c.id === query || c.summary.toLowerCase() === query.toLowerCase());
  if (exact.length === 1) return exact[0]!;
  const partial = calendars.filter((c) => c.summary.toLowerCase().includes(query.toLowerCase()));
  if (partial.length === 1) return partial[0]!;
  const options = (exact.length ? exact : partial).map((c) => `"${c.summary}" (${c.id})`).join(', ');
  throw new Error(options ? `"${query}" matches several calendars: ${options}. Use the id.` : `No calendar named "${query}". See \`tempo calendars\`.`);
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
