import { google } from 'googleapis';
import { dateRange, displayDate } from './time.js';

export function buildSheetMatrix(dataset) {
  const values = [];
  const columnCount = Math.max(2 + dataset.members.length, 2);
  values.push([dataset.sprint.name]);
  values.push(['Date', 'Question', ...dataset.members.map((member) => `${member.name}\n${member.email}`)]);
  const byKey = new Map(dataset.submissions.map((submission) => [
    `${submission.localDate}:${submission.userId}`, submission,
  ]));
  // Keep this merge entirely inside the two frozen label columns. Google Sheets
  // rejects merges that cross from frozen columns into non-frozen member columns.
  const merges = [{ startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 2 }];
  for (const localDate of dateRange(dataset.startDate, dataset.endDate)) {
    const startRow = values.length;
    const prompts = [
      ['Done', 'done'],
      ['To do', 'todo'],
      ['Problem', 'problem'],
    ];
    for (const [label, field] of prompts) {
      values.push([
        label === 'Done' ? displayDate(localDate) : '',
        label,
        ...dataset.members.map((member) => byKey.get(`${localDate}:${member.id}`)?.[field] ?? ''),
      ]);
    }
    merges.push({ startRowIndex: startRow, endRowIndex: startRow + 3, startColumnIndex: 0, endColumnIndex: 1 });
  }
  return { values, merges, rowCount: values.length, columnCount };
}

function safeSheetTitle(name, id) {
  const cleaned = String(name).replace(/[\\/?*\[\]:]/g, '-').trim().slice(0, 85) || `Sprint ${id}`;
  return `${cleaned} (${id})`;
}

function quotedSheetTitle(title) {
  return `'${title.replaceAll("'", "''")}'`;
}

export class GoogleSheetSync {
  constructor({ serviceAccountBase64, serviceAccountFile, spreadsheetId }, store) {
    this.store = store;
    this.spreadsheetId = spreadsheetId;
    this.enabled = Boolean((serviceAccountBase64 || serviceAccountFile) && spreadsheetId);
    this.sheets = null;
    if (this.enabled) {
      const credentials = serviceAccountBase64
        ? JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('utf8'))
        : undefined;
      const auth = new google.auth.GoogleAuth({
        credentials,
        keyFile: credentials ? undefined : serviceAccountFile,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      this.sheets = google.sheets({ version: 'v4', auth });
    }
  }

  async syncSprint(sprintId) {
    if (!this.enabled) throw new Error('Google Sheets synchronization is not configured.');
    const dataset = this.store.sprintDataset(sprintId);
    if (!dataset) throw new Error(`Sprint ${sprintId} no longer exists.`);
    const sheet = await this.ensureSheet(dataset.sprint);
    const matrix = buildSheetMatrix(dataset);
    const title = quotedSheetTitle(sheet.title);
    const metadata = await this.sheets.spreadsheets.get({
      spreadsheetId: this.spreadsheetId,
      fields: 'sheets(properties(sheetId,gridProperties),merges)',
    });
    const current = metadata.data.sheets.find((candidate) => candidate.properties.sheetId === sheet.id);
    const preparation = [];
    for (const merge of current?.merges ?? []) preparation.push({ unmergeCells: { range: merge } });
    preparation.push({
      updateSheetProperties: {
        properties: {
          sheetId: sheet.id,
          gridProperties: {
            rowCount: Math.max(matrix.rowCount, 100),
            columnCount: Math.max(matrix.columnCount, 10),
            frozenRowCount: 2,
            frozenColumnCount: 2,
          },
        },
        fields: 'gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount)',
      },
    });
    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: { requests: preparation },
    });
    await this.sheets.spreadsheets.values.clear({
      spreadsheetId: this.spreadsheetId,
      range: title,
    });
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${title}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: matrix.values },
    });

    const requests = [];
    for (const merge of matrix.merges) {
      requests.push({ mergeCells: { range: { sheetId: sheet.id, ...merge }, mergeType: 'MERGE_ALL' } });
    }
    requests.push(
      {
        repeatCell: {
          range: { sheetId: sheet.id, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: matrix.columnCount },
          cell: { userEnteredFormat: { backgroundColor: { red: 0.11, green: 0.31, blue: 0.55 }, textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } }, wrapStrategy: 'WRAP', verticalAlignment: 'MIDDLE' } },
          fields: 'userEnteredFormat',
        },
      },
      {
        repeatCell: {
          range: { sheetId: sheet.id, startRowIndex: 2, endRowIndex: matrix.rowCount, startColumnIndex: 0, endColumnIndex: matrix.columnCount },
          cell: { userEnteredFormat: { wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } },
          fields: 'userEnteredFormat.wrapStrategy,userEnteredFormat.verticalAlignment',
        },
      },
      {
        autoResizeDimensions: {
          dimensions: { sheetId: sheet.id, dimension: 'COLUMNS', startIndex: 0, endIndex: matrix.columnCount },
        },
      },
    );
    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: { requests },
    });
  }

  async ensureSheet(sprint) {
    const workbook = await this.sheets.spreadsheets.get({
      spreadsheetId: this.spreadsheetId,
      fields: 'sheets.properties(sheetId,title)',
    });
    let found = workbook.data.sheets.find((candidate) => candidate.properties.sheetId === sprint.sheetId);
    if (!found && sprint.sheetTitle) {
      found = workbook.data.sheets.find((candidate) => candidate.properties.title === sprint.sheetTitle);
    }
    if (!found) {
      const title = safeSheetTitle(sprint.name, sprint.id);
      const response = await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title } } }] },
      });
      const properties = response.data.replies[0].addSheet.properties;
      found = { properties };
    }
    this.store.setSprintSheet(sprint.id, found.properties.sheetId, found.properties.title);
    return { id: found.properties.sheetId, title: found.properties.title };
  }
}
