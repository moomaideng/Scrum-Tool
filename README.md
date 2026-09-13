# Scrum Tools

This repository contains two deliberately separate tools for the Eventory team:

- The retrospective board at the repository root, with **Continue**, **Cancel**, and **Add** notes.
- The daily standup application under `standup/`, served at `/standup/`, with Google login, sprint history, reminders, and Google Sheets synchronization.

## Retrospective

Team members join the retrospective with a name, then add shared notes. It does not use account authentication.

The **Reset board** button deliberately removes every participant and note after confirmation. Use it to start the next retrospective with a clean board.

It is intentionally separate from Eventory. It runs as one Docker container and stores its data in a named Docker volume, so restarts and image updates do not remove the board.

## Run both tools locally with Docker

1. Copy `.env.example` to `.env` and add the standup values described below.
2. Run:

   ```bash
   docker compose up --build
   ```

3. Open the retrospective at [http://localhost:4173](http://localhost:4173) and standup at [http://localhost:4174/standup/](http://localhost:4174/standup/).

To stop it, use `docker compose down`. This keeps the board data. `docker compose down --volumes` removes the board data too.

## Local development

Retrospective:

```bash
npm install
npm test
npm run dev
```

Standup:

```bash
cd standup
npm install
npm test
npm run dev
```

The standalone development servers default to ports 3000, so set `PORT=3001` when running both without Docker. Persistent data is written to each application's ignored `data/` directory.

## Standup configuration

Copy the variables from `standup/.env.example` into the root `.env` when using Compose, or export them before running `npm run dev` inside `standup/`.

### Google login

1. In a Google Cloud project, create a **Web application** client for Google Identity Services.
2. Add your exact origin, such as `https://eventory.ddns.net`, to **Authorized JavaScript origins**.
3. Add the exact login URI, such as `https://eventory.ddns.net/standup/auth/google`, to **Authorized redirect URIs**.
4. Put the client ID in `GOOGLE_CLIENT_ID`. A client secret is not required by this login flow.

Only verified Google emails on the administrator-managed allowlist can sign in. The Google account ID is the stable application identity; email and display name are refreshed on later logins.

### Administrator

Choose **Admin sign in** on the public login page and enter the password `admin`; no Google login is required for administration. The password-only admin session can manage the email allowlist, sprints, reminder settings, and integrations, but it cannot submit a standup. This is intentionally simple for a small trusted group. Change this design before exposing the tool to people you do not trust.

### Google Sheets

1. Enable the Google Sheets API in the Google Cloud project.
2. Create a service account and JSON key.
3. Share the destination spreadsheet with the service account's email as an editor.
4. Base64-encode the complete JSON key as one line and store it in `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`.
5. Store the spreadsheet ID from its URL in `GOOGLE_SPREADSHEET_ID`.

The application creates one worksheet per sprint. Members are columns; every Bangkok date occupies three rows labeled **Done**, **To do**, and **Problem**, with the date cell merged vertically. SQLite remains the source of truth and unsuccessful syncs are retried.

### Reminder email

The defaults use Gmail SMTP. Enable 2-Step Verification on the sending Google account, create an app password, and set `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM`. The normal Google account password must not be used. A different SMTP provider can be selected with the remaining SMTP settings.

At and after the administrator-selected Asia/Bangkok time (20:00 by default), the application sends one reminder to each active sprint member who has not submitted that day's standup. The admin can disable reminders per person or trigger the missing-person reminder run immediately.

## Deployment notes

Pushes to `main` deploy automatically through [`.github/workflows/ci.yml`](.github/workflows/ci.yml). The workflow tests and publishes separate ARM64 images, then deploys both services to `/opt/scrum-tool` on the Oracle server. It uses the same Oracle secrets as Eventory:

- `ORACLE_HOST`
- `ORACLE_USER`
- `ORACLE_SSH_KEY`
- `ORACLE_KNOWN_HOSTS`

Add these repository secrets for the standup integrations:

- `STANDUP_APP_ORIGIN`
- `STANDUP_GOOGLE_CLIENT_ID`
- `STANDUP_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`
- `STANDUP_GOOGLE_SPREADSHEET_ID`
- `STANDUP_SMTP_USER`
- `STANDUP_SMTP_PASSWORD`
- `STANDUP_SMTP_FROM`

The retrospective remains on public port 4173. Standup binds only to `127.0.0.1:4174`; add the locations from `deploy/nginx-standup.conf.example` to the existing HTTPS Nginx server block and reload Nginx after validating its configuration. No additional DNS record is required.

The name field is only a team identity, not authentication. Keep the port limited to your team/network if the notes should be private. Proper account authentication is needed before using it for sensitive or public content.
