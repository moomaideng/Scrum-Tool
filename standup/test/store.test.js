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
