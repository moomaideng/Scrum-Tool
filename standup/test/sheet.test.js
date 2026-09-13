import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSheetMatrix } from '../src/sheet.js';

test('Sheet matrix gives each member a column and each date three merged rows', () => {
  const matrix = buildSheetMatrix({
    sprint: { id: 1, name: 'Sprint 1' },
    startDate: '2026-09-13',
    endDate: '2026-09-14',
    members: [
      { id: 'one', name: 'One', email: 'one@example.com' },
      { id: 'two', name: 'Two', email: 'two@example.com' },
    ],
    submissions: [
      { userId: 'one', localDate: '2026-09-13', done: 'Built', todo: 'Test', problem: '-' },
    ],
  });

  assert.deepEqual(matrix.values[0], ['Sprint 1']);
  assert.deepEqual(matrix.values[1], ['Date', 'Question', 'One\none@example.com', 'Two\ntwo@example.com']);
  assert.deepEqual(matrix.values[2], ['13 Sept 2026', 'Done', 'Built', '']);
  assert.deepEqual(matrix.values[3], ['', 'To do', 'Test', '']);
  assert.deepEqual(matrix.values[4], ['', 'Problem', '-', '']);
  assert.deepEqual(matrix.values[5], ['14 Sept 2026', 'Done', '', '']);
  assert.deepEqual(matrix.merges[0], { startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 2 });
  assert.deepEqual(matrix.merges[1], { startRowIndex: 2, endRowIndex: 5, startColumnIndex: 0, endColumnIndex: 1 });
  assert.equal(matrix.rowCount, 8);
  assert.equal(matrix.columnCount, 4);
});
