import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RetrospectiveStore } from '../src/store.js';

test('a participant can add, edit, and delete only their own note', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'retro-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new RetrospectiveStore(directory);
  await store.initialize();
  const first = await store.join('Passakorn');
  const second = await store.join('Other member');
  const card = await store.addCard(first.participant, 'continue', 'We finished the main page.');

  assert.equal(store.board().cards.length, 1);
  assert.deepEqual(store.board().participants.map((participant) => participant.name), ['Other member', 'Passakorn']);
  assert.equal((await store.updateCard(card.id, second.participant, 'Changed')).kind, 'forbidden');
  assert.equal((await store.updateCard(card.id, first.participant, 'We finished the main page.')).kind, 'ok');
  assert.equal(await store.deleteCard(card.id, second.participant), 'forbidden');
  assert.equal(await store.deleteCard(card.id, first.participant), 'ok');
  assert.equal(store.board().cards.length, 0);
});

test('reset removes every participant, session, and note', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'retro-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new RetrospectiveStore(directory);
  await store.initialize();
  const joined = await store.join('Passakorn');
  await store.addCard(joined.participant, 'add', 'Do a short demo before the deadline.');

  await store.reset();
  assert.deepEqual(store.board().cards, []);
  assert.equal(store.participantForToken(joined.token), null);
  assert.equal(store.state.participants.length, 0);
});
