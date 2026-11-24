#!/usr/bin/env node
import { setTimeout as wait } from 'node:timers/promises';
import { setGlobalProxyFromEnv } from 'node:http';
import { loadConfig } from '../config.js';
import { hasStoredToken, signIn, signOut } from '../google/auth.js';
import { NotionApi } from './api.js';
import { exclusive, NotionPlanner } from './app.js';
import { Availability } from './google.js';
import { dataPath, readNotionSettings, settingsPath } from './settings.js';

const help = `Tempo for Notion Calendar

  setup [--hours-only]  Discover tasks and preview the next two days
  login                Connect Google with read-only permissions
  calendars            List calendars for the availability settings
  start                Approve a conflict-aware preview and publish sessions
  visible              Confirm the sessions appear in Notion Calendar
  run                  Update the plan once
  watch                Keep the plan current
  status               Show setup, pause, and last successful update
  pause                Pause automation and keep published sessions
  resume               Approve a refreshed setup preview and resume
  disconnect --keep   Remove the local connection and keep sessions
  disconnect --clear  Clear upcoming session dates, then remove the local connection

Settings: ${settingsPath()}`;

async function main() {
  const [command = 'help', flag] = process.argv.slice(2);
  if (command === 'help' || command === '--help') return console.log(help);
  // Honor managed proxies on Node versions that provide native fetch proxy support.
  if (typeof setGlobalProxyFromEnv === 'function' && process.env.HTTPS_PROXY) setGlobalProxyFromEnv();
  const base = loadConfig();
  const dir = dataPath();
  if (command === 'login') {
    await signIn('notion', { dataDir: dir, openBrowser: flag !== '--no-browser' });
    return;
  }
  const connect = async () => {
    try {
      return await Availability.connect(dir);
    } catch (error) {
      if (await hasStoredToken('user', base.dataDir)) {
        return Availability.connect(base.dataDir);
      }
      throw error;
    }
  };
  if (command === 'calendars') {
    for (const cal of await (await connect()).calendars()) console.log(`${cal.summary} · ${cal.primary ? 'primary' : cal.id}`);
    return;
  }
  const token = process.env.NOTION_API_TOKEN?.trim();
  if (!token && !['status', 'pause', 'visible'].includes(command) && !(command === 'disconnect' && flag === '--keep')) {
    throw new Error('Set NOTION_API_TOKEN and share the task database and private Sessions page with that integration.');
  }
  const app = new NotionPlanner(new NotionApi(token ?? ''), connect, dir);
  if (command === 'status') {
    const state = await app.state();
    console.log(!state.activated ? 'Setup pending' : state.paused ? 'Paused' : !state.visible ? 'Confirm calendar visibility' : 'Active');
    if (state.sessions) console.log(state.sessions.url);
    if (state.problem && !state.paused) console.log('Last update needs attention · ' + state.problem);
    if (state.lastSuccess) {
      const config = await readNotionSettings();
      console.log('Last successful update · ' + new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short',
        timeZone: config.timezone }).format(new Date(state.lastSuccess)));
    }
    return;
  }
  if (command === 'watch') {
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    process.once('SIGTERM', () => controller.abort());
    let lastError = '';
    let seconds = 90;
    while (!controller.signal.aborted) {
      try {
        const config = await readNotionSettings();
        seconds = config.pollSeconds;
        await exclusive(dir, async () => {
          try {
            await app.update(config);
          } catch (error) {
            await app.recordFailure(errorText(error));
            throw error;
          }
        });
        if (lastError) console.log('Planning is current.');
        lastError = '';
      } catch (error) {
        const message = errorText(error);
        if (lastError !== message) console.error(message);
        lastError = message;
      }
      await wait(seconds * 1000, undefined, { signal: controller.signal }).catch(() => {});
    }
    return;
  }
  await exclusive(dir, async () => {
    const config = await readNotionSettings();
    switch (command) {
      case 'setup': return app.preview(config, flag === '--hours-only');
      case 'start': return app.start(config);
      case 'run': return app.update(config);
      case 'visible': return app.setFlag('visible');
      case 'pause': return app.setFlag('paused');
      case 'resume': return app.update(config, true);
      case 'disconnect':
        if (flag !== '--keep' && flag !== '--clear') throw new Error('Choose disconnect --keep or disconnect --clear.');
        await app.disconnect(config, flag === '--clear');
        await signOut('notion', dir);
        console.log('Tempo disconnected. Revoke the Notion integration connection in Notion when you no longer need it.');
        return;
      default: throw new Error('Unknown command. Run npm run notion -- help.');
    }
  });
}

function errorText(error: unknown) {
  if (error instanceof Error) {
    if (error.message === 'fetch failed') return 'The Notion API could not be reached. Check your network configuration.';
    // Google SDK errors can contain request credentials in their details.
    if (error.name === 'GaxiosError') return 'The Google request failed. Check the OAuth connection and permissions.';
    return error.message;
  }
  return 'Tempo could not complete this command.';
}

void main().catch(error => {
  console.error(errorText(error));
  process.exitCode = 1;
});
