import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { StandupStore } from '../src/store.js';

async function fixture(t, initial = '2026-09-13T05:00:00.000Z') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'standup-store-'));
  let now = new Date(initial);
  const store = new StandupStore(directory, { now: () => now });
  await store.initialize();
  t.after(() => { store.close(); return rm(directory, { recursive: true, force: true }); });
  return { store, setNow(value) { now = new Date(value); } };
}

function profile(id, name = id) {
  return { id, email: `${id}@example.com`, name, avatarUrl: null };
}

test('users submit once per Bangkok date and can update that entry', async (t) => {
  const { store } = await fixture(t);
  const user = store.loginGoogleUser(profile('one', 'One'));
  store.allowEmail(user.email);
  const sprint = store.createSprint('Sprint 1');
  const first = store.upsertToday(user.id, { done: 'Built it', todo: 'Test it', problem: '-' });
  const second = store.upsertToday(user.id, { done: 'Built and reviewed it', todo: 'Test it', problem: '-' });

  assert.equal(first.kind, 'ok');
  assert.equal(second.submission.id, first.submission.id);
  assert.equal(second.submission.done, 'Built and reviewed it');
  const dashboard = store.dashboard(sprint.id, '2026-09-13', user.id);
  assert.equal(dashboard.submissions.length, 1);
  assert.equal(dashboard.ownSubmission.userId, user.id);
});

test('switching sprint archives the previous sprint and preserves its entries', async (t) => {
  const { store, setNow } = await fixture(t);
  const user = store.loginGoogleUser(profile('one'));
  store.allowEmail(user.email);
  const first = store.createSprint('Sprint 1');
  store.upsertToday(user.id, { done: 'A', todo: 'B', problem: '-' });
  setNow('2026-09-14T05:00:00.000Z');
  const second = store.createSprint('Sprint 2');

  assert.equal(store.getSprint(first.id).endsAt, '2026-09-14T05:00:00.000Z');
  assert.equal(store.getActiveSprint().id, second.id);
  assert.equal(store.dashboard(first.id, '2026-09-13', user.id).submissions.length, 1);
  assert.equal(store.dashboard(second.id, '2026-09-14', user.id).members.length, 1);
});

test('a first login joins the active sprint and reminder setting is admin controlled', async (t) => {
  const { store } = await fixture(t);
  store.createSprint('Sprint 1');
  const user = store.loginGoogleUser(profile('late'));
  assert.equal(store.dashboard(null, '2026-09-13', user.id).members.length, 1);
  assert.equal(store.reminderCandidates(store.getActiveSprint().id, '2026-09-13').length, 1);
  store.setUserReminders(user.id, false);
  assert.equal(store.reminderCandidates(store.getActiveSprint().id, '2026-09-13').length, 0);
});

test('sessions expire and admin elevation has its own expiry', async (t) => {
  const { store, setNow } = await fixture(t);
  const user = store.loginGoogleUser(profile('one'));
  const session = store.createSession(user.id, 60);
  assert.equal(store.sessionForToken(session.token).email, user.email);
  const adminUntil = store.elevateSession(session.token, 30);
  assert.equal(store.sessionForToken(session.token).adminUntil, adminUntil);
  setNow('2026-09-13T05:01:01.000Z');
  assert.equal(store.sessionForToken(session.token), null);
});

test('admin controls allowed emails and the persisted reminder time', async (t) => {
  const { store } = await fixture(t);
  const sprint = store.createSprint('Sprint 1');
  assert.equal(store.isEmailAllowed('friend@example.com'), false);
  const invited = store.allowEmail('Friend@Example.com');
  assert.equal(store.isEmailAllowed('friend@example.com'), true);
  assert.equal(store.listAllowedEmails()[0].email, 'friend@example.com');
  assert.equal(invited.registered, 0);
  assert.equal(store.listUsers().length, 1);
  assert.equal(store.dashboard(sprint.id, '2026-09-13', invited.userId).members.length, 1);
  assert.equal(store.reminderCandidates(sprint.id, '2026-09-13').length, 1);
  assert.equal(store.getReminderTime(), '20:00');
  assert.equal(store.setReminderTime('18:45'), '18:45');
  assert.equal(store.getReminderTime(), '18:45');
  assert.equal(store.removeAllowedEmail('FRIEND@example.com'), true);
  assert.equal(store.isEmailAllowed('friend@example.com'), false);
  assert.equal(store.dashboard(sprint.id, '2026-09-13', invited.userId).members.length, 0);
  assert.equal(store.sprintDataset(sprint.id).members.length, 0);
  store.allowEmail('friend@example.com');
  assert.equal(store.dashboard(sprint.id, '2026-09-13', invited.userId).members.length, 1);
  assert.equal(store.reminderCandidates(sprint.id, '2026-09-13').length, 1);
});

test('an admin-set Discord name is kept for reminders and Sheets', async (t) => {
  const { store } = await fixture(t);
  const sprint = store.createSprint('Sprint 1');
  const invited = store.allowEmail('friend@example.com', '123456789012345678');
  assert.equal(invited.discordName, '123456789012345678');
  const user = store.listUsers()[0];
  assert.equal(user.discordName, '123456789012345678');
  store.setUserDiscordName(user.id, 'Friend Name');
  assert.equal(store.sprintDataset(sprint.id).members[0].discordName, 'Friend Name');
  assert.equal(store.missingReminderMembers(sprint.id, '2026-09-13')[0].discordName, 'Friend Name');
});

test('an admin can create a historical submission for a sprint member', async (t) => {
  const { store } = await fixture(t);
  const user = store.loginGoogleUser(profile('one', 'One'));
  store.allowEmail(user.email);
  const sprint = store.createSprint('Sprint 1');
  const result = store.upsertAdminSubmission(sprint.id, user.id, '2026-08-25', {
    done: 'Historical work', todo: 'Follow-up', problem: '',
  });
  assert.equal(result.kind, 'ok');
  assert.equal(store.dashboard(sprint.id, '2026-08-25', user.id).submissions[0].done, 'Historical work');
  assert.equal(store.sprintDataset(sprint.id).startDate, '2026-08-25');
  assert.equal(store.sheetSyncStatus()[0].status, 'pending');
});

test('existing users are migrated onto the allowlist only once', async (t) => {
  const { store } = await fixture(t);
  const user = store.loginGoogleUser(profile('existing'));
  store.db.prepare("DELETE FROM app_settings WHERE key = 'allowlist_initialized'").run();
  store.close();
  await store.initialize();
  assert.equal(store.isEmailAllowed(user.email), true);
  store.removeAllowedEmail(user.email);
  store.close();
  await store.initialize();
  assert.equal(store.isEmailAllowed(user.email), false);
});

test('an allowlist entry from an older deployment becomes a pending roster member', async (t) => {
  const { store } = await fixture(t);
  const sprint = store.createSprint('Sprint 1');
  store.db.prepare('INSERT INTO allowed_emails (email, created_at) VALUES (?, ?)')
    .run('legacy@example.com', store.nowIso());
  store.close();
  await store.initialize();
  const pending = store.listUsers().find((user) => user.email === 'legacy@example.com');
  assert.equal(pending.registered, 0);
  assert.equal(store.dashboard(sprint.id, '2026-09-13', pending.id).members.length, 1);
});

test('startup removes stale active membership left by an older deployment', async (t) => {
  const { store } = await fixture(t);
  const invited = store.allowEmail('removed@example.com');
  const sprint = store.createSprint('Sprint 1');
  assert.equal(store.dashboard(sprint.id, '2026-09-13', invited.userId).members.length, 1);
  store.db.prepare('DELETE FROM allowed_emails WHERE email = ?').run('removed@example.com');
  store.close();
  await store.initialize();
  assert.equal(store.dashboard(sprint.id, '2026-09-13', invited.userId).members.length, 0);
  assert.equal(store.sprintDataset(sprint.id).members.length, 0);
});
