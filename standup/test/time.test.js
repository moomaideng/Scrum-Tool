import assert from 'node:assert/strict';
import test from 'node:test';
import { bangkokNow, dateRange, displayDate } from '../src/time.js';

test('Bangkok date changes at local midnight', () => {
  assert.deepEqual(bangkokNow(new Date('2026-09-13T16:59:00.000Z')), { date: '2026-09-13', hour: 23, minute: 59 });
  assert.deepEqual(bangkokNow(new Date('2026-09-13T17:00:00.000Z')), { date: '2026-09-14', hour: 0, minute: 0 });
});

test('dateRange includes both endpoints', () => {
  assert.deepEqual(dateRange('2026-09-29', '2026-10-01'), ['2026-09-29', '2026-09-30', '2026-10-01']);
  assert.equal(displayDate('2026-09-13'), '13 Sept 2026');
});
