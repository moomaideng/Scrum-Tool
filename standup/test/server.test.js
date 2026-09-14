import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { StandupStore } from '../src/store.js';
import { createStandupApplication } from '../src/server.js';

test('Google login creates a cookie session and permits a current-day submission', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'standup-http-'));
  const store = new StandupStore(directory);
  await store.initialize();
  const publicDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
  const config = {
    port: 0,
    basePath: '/standup',
    appOrigin: 'http://standup.test',
    publicDirectory,
    dataDirectory: directory,
    googleClientId: 'test-client',
    googleServiceAccountBase64: '',
    googleSpreadsheetId: '',
    smtp: { host: '', port: 465, secure: true, user: '', password: '', from: '' },
  };
  const googleClient = {
    async verifyIdToken({ audience }) {
      assert.equal(audience, 'test-client');
      return { getPayload: () => ({ sub: 'google-1', email: 'member@example.com', email_verified: true, name: 'Member' }) };
    },
  };
  const { app } = await createStandupApplication({
    config,
    store,
    googleClient,
    sheetSync: { enabled: false },
    mailer: { enabled: false },
    scheduler: { async runOnce() {} },
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(`${origin}/standup/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Daily standup/);
  const canonicalRedirect = await fetch(`${origin}/standup`, { redirect: 'manual' });
  assert.equal(canonicalRedirect.status, 308);
  assert.equal(canonicalRedirect.headers.get('location'), '/standup/');
  const privacy = await fetch(`${origin}/standup/privacy`);
  assert.equal(privacy.status, 200);
  assert.match(await privacy.text(), /Privacy policy/);
  const csrf = 'known-csrf-token';
  const deniedLogin = await fetch(`${origin}/standup/auth/google`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `g_csrf_token=${csrf}` },
    body: new URLSearchParams({ credential: 'google-token', g_csrf_token: csrf }),
  });
  assert.equal(deniedLogin.status, 303);
  assert.equal(deniedLogin.headers.get('location'), '/standup/?auth_error=not_allowed');
  store.allowEmail('member@example.com');
  const login = await fetch(`${origin}/standup/auth/google`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `g_csrf_token=${csrf}` },
    body: new URLSearchParams({ credential: 'google-token', g_csrf_token: csrf }),
  });
  assert.equal(login.status, 303);
  assert.equal(login.headers.get('location'), '/standup/');
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const me = await fetch(`${origin}/standup/api/me`, { headers: { Cookie: cookie } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.email, 'member@example.com');

  store.createSprint('Sprint 1');
  const submission = await fetch(`${origin}/standup/api/submissions/today`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: config.appOrigin },
    body: JSON.stringify({ done: 'Finished auth', todo: 'Build UI', problem: '-' }),
  });
  assert.equal(submission.status, 200);
  assert.equal((await submission.json()).done, 'Finished auth');

  const dashboard = await fetch(`${origin}/standup/api/dashboard`, { headers: { Cookie: cookie } });
  const dashboardBody = await dashboard.json();
  assert.equal(dashboardBody.submissions.length, 1);
  assert.equal(dashboardBody.canEdit, true);
});

test('state-changing APIs reject a cross-origin request', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'standup-origin-'));
  const store = new StandupStore(directory);
  await store.initialize();
  const user = store.loginGoogleUser({ id: 'one', email: 'one@example.com', name: 'One' });
  const session = store.createSession(user.id);
  const config = {
    port: 0, basePath: '/standup', appOrigin: 'https://expected.example',
    publicDirectory: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public'), dataDirectory: directory,
    googleClientId: '', googleServiceAccountBase64: '', googleSpreadsheetId: '',
    smtp: { host: '', port: 465, secure: true, user: '', password: '', from: '' },
  };
  const { app } = await createStandupApplication({
    config, store, googleClient: {}, sheetSync: { enabled: false }, mailer: { enabled: false }, scheduler: { async runOnce() {} },
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/standup/api/logout`, {
    method: 'POST', headers: { Cookie: `standup_session=${session.token}`, Origin: 'https://attacker.example' },
  });
  assert.equal(response.status, 403);
});

test('hardcoded admin password can start a new sprint', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'standup-admin-'));
  const store = new StandupStore(directory);
  await store.initialize();
  const config = {
    port: 0, basePath: '/standup', appOrigin: 'https://standup.example',
    publicDirectory: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public'), dataDirectory: directory,
    googleClientId: '', googleServiceAccountBase64: '', googleSpreadsheetId: '',
    smtp: { host: '', port: 465, secure: true, user: '', password: '', from: '' },
  };
  const { app } = await createStandupApplication({
    config, store, googleClient: {}, sheetSync: { enabled: false }, mailer: { enabled: false }, scheduler: { async runOnce() {} },
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'Content-Type': 'application/json', Origin: config.appOrigin };
  const unlock = await fetch(`${origin}/standup/api/admin/session`, {
    method: 'POST', headers, body: JSON.stringify({ password: 'admin' }),
  });
  assert.equal(unlock.status, 200);
  const adminCookie = unlock.headers.get('set-cookie').split(';')[0];
  const create = await fetch(`${origin}/standup/api/admin/sprints`, {
    method: 'POST', headers: { ...headers, Cookie: adminCookie }, body: JSON.stringify({ name: 'Sprint 1' }),
  });
  assert.equal(create.status, 201);
  const createdSprint = await create.json();
  assert.equal(createdSprint.name, 'Sprint 1');

  const allow = await fetch(`${origin}/standup/api/admin/allowed-emails`, {
    method: 'POST', headers: { ...headers, Cookie: adminCookie }, body: JSON.stringify({ email: 'Friend@Example.com' }),
  });
  assert.equal(allow.status, 201);
  const allowedUser = await allow.json();
  assert.equal(allowedUser.email, 'friend@example.com');

  const reminderTime = await fetch(`${origin}/standup/api/admin/reminders`, {
    method: 'PATCH', headers: { ...headers, Cookie: adminCookie },
    body: JSON.stringify({ time: '19:30', emailDailyEnabled: true, discordDailyEnabled: false }),
  });
  assert.equal(reminderTime.status, 200);
  assert.equal((await reminderTime.json()).time, '19:30');

  const historicalRecord = await fetch(`${origin}/standup/api/admin/records`, {
    method: 'PUT', headers: { ...headers, Cookie: adminCookie },
    body: JSON.stringify({ sprintId: createdSprint.id, userId: allowedUser.userId, date: '2026-08-25', done: 'Imported', todo: 'Continue', problem: '' }),
  });
  assert.equal(historicalRecord.status, 200);
  assert.equal((await historicalRecord.json()).done, 'Imported');

  const remove = await fetch(`${origin}/standup/api/admin/allowed-emails/${encodeURIComponent('friend@example.com')}`, {
    method: 'DELETE', headers: { ...headers, Cookie: adminCookie },
  });
  assert.equal(remove.status, 204);
  assert.equal(store.dashboard(store.getActiveSprint().id, '2026-09-13', 'admin').members.length, 0);
  assert.equal(store.sprintDataset(store.getActiveSprint().id).members.length, 0);
});
