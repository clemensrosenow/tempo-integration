import { loadConfig } from '../src/config.js';
import { getAuthorizedClient } from '../src/google/auth.js';
import { calendar } from 'googleapis/build/src/apis/calendar/index.js';
loadConfig();
const st = JSON.parse((await import('node:fs')).readFileSync('.tempo/state.json', 'utf8'));
const cal = calendar({ version: 'v3', auth: await getAuthorizedClient('sandbox', '.tempo') });
const items = (await cal.events.list({ calendarId: st.tempoCalendarId, timeMin: new Date().toISOString(), singleEvents: true, orderBy: 'startTime' })).data.items ?? [];
for (const e of items) if (['SEpsUDAyaDRDOGlTUWJjUw', 'em5nNnNQRnZZNmR1b2dGZw'].includes(e.extendedProperties?.private?.tempoTaskId ?? '')) console.log(e.summary, e.start?.dateTime, '\n', e.description, '\n');
