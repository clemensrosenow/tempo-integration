# Google setup for Tempo

Tempo uses two Google accounts:

- **Your account** (for example your student Gmail). Tempo reads your calendars and Google Tasks and
  writes blocks into a "Tempo" calendar that it creates.
- **A separate Tempo organizer account** (for example a new `tempo.yourname@gmail.com`). Tempo sends its
  questions as calendar invitations, and an invitation needs an organizer who is not the attendee.

Both sign in through one OAuth client in your own Google Cloud project, which stays in **Testing**
mode. No verification is needed.

## 1. Create a Google Cloud project

1. Open <https://console.cloud.google.com/> and sign in (any account; your own is fine).
2. Click the project picker at the top → **New project** → name it `Tempo` → **Create**, then select it.

## 2. Enable the APIs

1. Go to **APIs & Services → Library**.
2. Search for **Google Calendar API** → **Enable**.
3. Search for **Google Tasks API** → **Enable**.

## 3. Configure the OAuth consent screen (Google Auth Platform)

1. Go to **APIs & Services → OAuth consent screen**. In the current console this opens
   **Google Auth Platform**; click **Get started** if asked.
2. **App information:** App name `Tempo`, user support email = your email → Next.
3. **Audience:** choose **External** → Next.
4. **Contact information:** your email → Next → accept the policy → **Create**.
5. Open **Audience** and keep **Publishing status: Testing**. Under **Test users** click **Add users**
   and add **both** accounts:
   - your own Google account
   - the Tempo organizer account

   Only test users can sign in (at most 100). You will see a "Google hasn't verified this app"
   warning. Click **Continue**; this is expected in Testing mode.
6. (Optional) Under **Data Access** you can list the scopes. In Testing mode this is not required for
   test users. Tempo requests:
   - your account: `openid`, `email`, `.../auth/calendar`, `.../auth/tasks.readonly`
   - organizer account: `openid`, `email`, `.../auth/calendar.events.owned`

## 4. Create the OAuth client (Desktop app)

1. Go to **Google Auth Platform → Clients** (or **APIs & Services → Credentials → Create
   credentials → OAuth client ID**).
2. **Application type: Desktop app**, name `Tempo CLI` → **Create**.
3. Click **Download JSON** and save the file as `.tempo/credentials.json` in the repo:

   ```sh
   mkdir -p .tempo && mv ~/Downloads/client_secret_*.json .tempo/credentials.json
   ```

   Instead of the file, you can set environment variables (for example in `.env`):

   ```sh
   GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-...
   ```

   Environment variables take priority over the file. `.tempo/` is git-ignored. Never commit it.

Desktop clients need no redirect URI configuration. Tempo listens on `http://127.0.0.1:<random port>`
during sign-in.

## 5. Sign in

```sh
npm run tempo -- login              # sign in with YOUR account
npm run tempo -- login --organizer  # sign in with the Tempo ORGANIZER account
```

Each command prints a URL and tries to open it in your browser (`open` on macOS, `xdg-open` on Linux;
add `--no-browser` to only print it). Pick the right account, click **Continue** on the "unverified
app" screen, and **tick every checkbox** on the permission screen. Tempo refuses a sign-in that is
missing a permission. After the redirect the browser shows "Tempo is connected".

Tokens are stored in `.tempo/tokens/user.json` and `.tempo/tokens/organizer.json` (file mode 0600).
Tempo refuses to connect the same Google account as both user and organizer.

Without the organizer login Tempo still plans, repairs and learns, but it cannot ask questions
(missed due dates, big changes and so on).

Then run `npm run tempo -- setup`.

## 6. Re-login every 7 days (Testing mode)

In Testing mode Google issues refresh tokens that **expire 7 days** after consent, because Tempo
requests Calendar and Tasks scopes, not just name and email. When this happens Tempo fails with an
`invalid_grant` / "not signed in" error. Sign in again:

```sh
npm run tempo -- login
npm run tempo -- login --organizer
```

To disconnect an account (revokes the grant at Google and deletes the local token):

```sh
npm run tempo -- logout
npm run tempo -- logout --organizer
```

## Optional: push notifications instead of polling

By default Tempo polls Google Calendar with sync tokens. Google Tasks can only be polled. Instant
calendar push (`events.watch`) needs a **public HTTPS URL with a valid certificate**. Google rejects
`http://`, localhost and self-signed certificates. Locally you can use a tunnel, for example
`cloudflared tunnel --url http://127.0.0.1:8787`, and give Tempo the `https://…` URL it prints as the
webhook address. Channels expire and Tempo creates new ones when it restarts.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Error 403: access_denied` / "app has not completed verification" | The account is not in **Audience → Test users**. Add it. |
| `invalid_grant` after a week | Testing-mode refresh token expired. Run `tempo login` again (see step 6). |
| "Google did not grant all permissions" | You unticked a checkbox. Log in again and tick everything. |
| `No Google OAuth client found` | `.tempo/credentials.json` is missing, or `GOOGLE_CLIENT_ID` is not set. |
| `Google Calendar API has not been used in project …` | Enable the API (step 2) and wait a minute. |
| No invitations arrive | Check that the organizer is logged in (`tempo login --organizer`) and is a different account. |

## 6. Make Tempo's questions visible in your calendar

Tempo asks questions as invitations from the organizer account. Many Google accounts only add
invitations from **known senders** to the calendar (Google Calendar → Settings → General → Event
settings → "Add invitations to my calendar"). Then "Tempo asks: …" only arrives by e-mail.
`tempo setup` and `tempo status` check this (Calendar API setting `hideInvitationsSetting`) and warn.
Fix it with one of:

- set "Add invitations to my calendar" to **From everyone**, or
- add the organizer account to your Google Contacts (it then counts as a known sender).

## 7. (Developers) Sandbox account for live experiments

`scripts/sandbox.ts` fills a **test** account with sample calendars, events and tasks and simulates
user actions (see the README). It signs in separately with full Calendar and Tasks access
(`npm run sandbox -- login`, token `.tempo/tokens/sandbox.json`) and only writes to that account,
and only if it is the same account Tempo itself is signed in with. Never use it with your real account.
