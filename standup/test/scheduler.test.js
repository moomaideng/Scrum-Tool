import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { StandupStore } from '../src/store.js';
import { StandupScheduler } from '../src/scheduler.js';

test('scheduler emails a missing member once after 20:00 Bangkok time', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'standup-scheduler-'));
  const now = new Date('2026-09-13T13:05:00.000Z');
  const store = new StandupStore(directory, { now: () => now });
  await store.initialize();
  t.after(() => { store.close(); return rm(directory, { recursive: true, force: true }); });
  const user = store.loginGoogleUser({ id: 'one', email: 'one@example.com', name: 'One' });
  store.createSprint('Sprint 1');
  const sent = [];
  const scheduler = new StandupScheduler({
    store,
    sheetSync: { enabled: false },
    mailer: { enabled: true, async send(message) { sent.push(message); } },
    applicationUrl: 'https://example.com/standup/',
    now: () => now,
    logger: { error() {} },
  });

  await scheduler.runOnce();
  await scheduler.runOnce();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].user.email, user.email);
  assert.equal(store.reminderStatus()[0].sentAt, now.toISOString());
});

test('scheduler does not email a member who submitted', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'standup-scheduler-'));
  const now = new Date('2026-09-13T13:05:00.000Z');
  const store = new StandupStore(directory, { now: () => now });
  await store.initialize();
  t.after(() => { store.close(); return rm(directory, { recursive: true, force: true }); });
  const user = store.loginGoogleUser({ id: 'one', email: 'one@example.com', name: 'One' });
  store.createSprint('Sprint 1');
  store.upsertToday(user.id, { done: 'Done', todo: 'Next', problem: '-' });
  let count = 0;
  const scheduler = new StandupScheduler({
    store,
    sheetSync: { enabled: false },
    mailer: { enabled: true, async send() { count += 1; } },
    applicationUrl: 'https://example.com/standup/', now: () => now, logger: { error() {} },
  });
  await scheduler.runOnce();
  assert.equal(count, 0);
});
