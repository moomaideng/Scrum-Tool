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
  store.allowEmail(user.email);
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
  store.allowEmail(user.email);
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

test('scheduler uses the admin-selected Bangkok reminder time', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'standup-scheduler-'));
  let now = new Date('2026-09-13T11:29:00.000Z'); // 18:29 Bangkok
  const store = new StandupStore(directory, { now: () => now });
  await store.initialize();
  t.after(() => { store.close(); return rm(directory, { recursive: true, force: true }); });
  store.loginGoogleUser({ id: 'one', email: 'one@example.com', name: 'One' });
  store.allowEmail('one@example.com');
  store.createSprint('Sprint 1');
  store.setReminderSettings({ firstTime: '18:30', time: '18:30', emailDailyEnabled: true, discordDailyEnabled: true });
  store.setReminderTime('18:30');
  let count = 0;
  const scheduler = new StandupScheduler({
    store,
    sheetSync: { enabled: false },
    mailer: { enabled: true, async send() { count += 1; } },
    applicationUrl: 'https://example.com/standup/', now: () => now, logger: { error() {} },
  });
  await scheduler.runOnce();
  assert.equal(count, 0);
  now = new Date('2026-09-13T11:30:00.000Z');
  await scheduler.runOnce();
  assert.equal(count, 1);
});

test('scheduler sends distinct first and second reminders with the response rate', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'standup-scheduler-'));
  let now = new Date('2026-09-13T03:05:00.000Z'); // 10:05 Bangkok
  const store = new StandupStore(directory, { now: () => now });
  await store.initialize();
  t.after(() => { store.close(); return rm(directory, { recursive: true, force: true }); });
  const user = store.loginGoogleUser({ id: 'one', email: 'one@example.com', name: 'One' });
  store.allowEmail(user.email);
  store.createSprint('Sprint 1');
  const sent = [];
  const scheduler = new StandupScheduler({
    store, sheetSync: { enabled: false }, mailer: { enabled: true, async send(message) { sent.push(message); } },
    applicationUrl: 'https://example.com/standup/', now: () => now, logger: { error() {} },
  });
  await scheduler.runOnce();
  now = new Date('2026-09-13T13:05:00.000Z'); // 20:05 Bangkok
  await scheduler.runOnce();
  await scheduler.runOnce();
  assert.equal(sent.length, 2);
  assert.equal(sent[0].reminderKind, 'first');
  assert.equal(sent[1].reminderKind, 'second');
  assert.deepEqual(sent[0].responseRate, { total: 1, submitted: 0, percent: 0, previousDate: '2026-09-12', previousSubmitted: 0, previousPercent: 0, change: 0 });
  const delivery = store.reminderStatus()[0];
  assert.equal(delivery.automaticFirstSent, 1);
  assert.equal(delivery.automaticSecondSent, 1);
});

test('admin can manually send reminders before the scheduled time', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'standup-scheduler-'));
  const now = new Date('2026-09-13T05:00:00.000Z');
  const store = new StandupStore(directory, { now: () => now });
  await store.initialize();
  t.after(() => { store.close(); return rm(directory, { recursive: true, force: true }); });
  store.loginGoogleUser({ id: 'one', email: 'one@example.com', name: 'One' });
  store.allowEmail('one@example.com');
  store.createSprint('Sprint 1');
  let count = 0;
  const scheduler = new StandupScheduler({
    store,
    sheetSync: { enabled: false },
    mailer: { enabled: true, async send() { count += 1; } },
    applicationUrl: 'https://example.com/standup/', now: () => now, logger: { error() {} },
  });
  const result = await scheduler.sendRemindersNow();
  assert.deepEqual(result, { sent: 1, failed: 0, busy: false, noSprint: false });
  const second = await scheduler.sendRemindersNow();
  const third = await scheduler.sendRemindersNow();
  assert.equal(second.sent, 1);
  assert.equal(third.sent, 0);
  assert.equal(count, 2);
});

test('scheduler posts one Discord reminder per automatic phase', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'standup-scheduler-'));
  let now = new Date('2026-09-13T03:05:00.000Z'); // 10:05 Bangkok
  const store = new StandupStore(directory, { now: () => now });
  await store.initialize();
  t.after(() => { store.close(); return rm(directory, { recursive: true, force: true }); });
  store.loginGoogleUser({ id: 'one', email: 'one@example.com', name: 'One' });
  store.allowEmail('one@example.com');
  store.createSprint('Sprint 1');
  const sent = [];
  const scheduler = new StandupScheduler({
    store, sheetSync: { enabled: false }, mailer: { enabled: false },
    discordNotifier: { enabled: true, async send(message) { sent.push(message); } },
    applicationUrl: 'https://example.com/standup/', now: () => now, logger: { error() {} },
  });
  await scheduler.runOnce();
  now = new Date('2026-09-13T13:05:00.000Z'); // 20:05 Bangkok
  await scheduler.runOnce();
  now = new Date('2026-09-13T13:21:00.000Z'); // more than the retry guard, still second phase
  await scheduler.runOnce();
  assert.equal(sent.length, 2);
  assert.equal(sent[0].users[0].email, 'one@example.com');
  assert.equal(sent[0].reminderKind, 'first');
  assert.equal(sent[1].reminderKind, 'second');
  assert.equal(store.discordDeliveryStatus()[0].automaticFirstSent, 1);
  assert.equal(store.discordDeliveryStatus()[0].automaticSecondSent, 1);
});
