import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { bangkokNow, isoDateFromInstant } from './time.js';

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function row(value) {
  return value ? { ...value } : null;
}

function rows(values) {
  return values.map((value) => ({ ...value }));
}

export class StandupStore {
  constructor(dataDir, { now = () => new Date() } = {}) {
    this.file = path.join(dataDir, 'standup.sqlite');
    this.dataDir = dataDir;
    this.now = now;
    this.db = null;
  }

  async initialize() {
    await mkdir(this.dataDir, { recursive: true });
    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        google_subject TEXT UNIQUE,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        avatar_url TEXT,
        reminders_enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        last_login_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS allowed_emails (
        email TEXT PRIMARY KEY COLLATE NOCASE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        admin_until TEXT
      );
      CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);
      CREATE TABLE IF NOT EXISTS admin_sessions (
        token_hash TEXT PRIMARY KEY,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sprints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        starts_at TEXT NOT NULL,
        ends_at TEXT,
        sheet_id INTEGER,
        sheet_title TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_sprint ON sprints((1)) WHERE ends_at IS NULL;
      CREATE TABLE IF NOT EXISTS sprint_members (
        sprint_id INTEGER NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        joined_at TEXT NOT NULL,
        PRIMARY KEY (sprint_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sprint_id INTEGER NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        local_date TEXT NOT NULL,
        done TEXT NOT NULL,
        todo TEXT NOT NULL,
        problem TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (sprint_id, user_id, local_date)
      );
      CREATE INDEX IF NOT EXISTS submissions_lookup ON submissions(sprint_id, local_date);
      CREATE TABLE IF NOT EXISTS reminder_deliveries (
        sprint_id INTEGER NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        local_date TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        sent_at TEXT,
        sent_count INTEGER NOT NULL DEFAULT 0,
        automatic_sent INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        PRIMARY KEY (sprint_id, user_id, local_date)
      );
      CREATE TABLE IF NOT EXISTS sheet_sync_jobs (
        sprint_id INTEGER PRIMARY KEY REFERENCES sprints(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        last_attempt_at TEXT,
        completed_at TEXT,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS discord_deliveries (
        sprint_id INTEGER NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
        local_date TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        sent_at TEXT,
        automatic_sent INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        PRIMARY KEY (sprint_id, local_date)
      );
      INSERT INTO allowed_emails (email, created_at)
        SELECT lower(email), created_at FROM users
        WHERE NOT EXISTS (SELECT 1 FROM app_settings WHERE key = 'allowlist_initialized')
        ON CONFLICT(email) DO NOTHING;
      INSERT OR IGNORE INTO app_settings (key, value) VALUES ('allowlist_initialized', 'true');
      INSERT OR IGNORE INTO app_settings (key, value) VALUES ('reminder_time', '20:00');
      INSERT OR IGNORE INTO app_settings (key, value) VALUES ('email_daily_enabled', 'true');
      INSERT OR IGNORE INTO app_settings (key, value) VALUES ('discord_daily_enabled', 'true');
    `);
    const userColumns = this.db.prepare('PRAGMA table_info(users)').all();
    if (!userColumns.some((column) => column.name === 'google_subject')) {
      this.db.exec('ALTER TABLE users ADD COLUMN google_subject TEXT; UPDATE users SET google_subject = id;');
    }
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_google_subject ON users(google_subject) WHERE google_subject IS NOT NULL;');
    const reminderColumns = this.db.prepare('PRAGMA table_info(reminder_deliveries)').all();
    if (!reminderColumns.some((column) => column.name === 'sent_count')) {
      this.db.exec(`
        ALTER TABLE reminder_deliveries ADD COLUMN sent_count INTEGER NOT NULL DEFAULT 0;
        UPDATE reminder_deliveries SET sent_count = 1 WHERE sent_at IS NOT NULL;
      `);
    }
    if (!reminderColumns.some((column) => column.name === 'automatic_sent')) {
      this.db.exec('ALTER TABLE reminder_deliveries ADD COLUMN automatic_sent INTEGER NOT NULL DEFAULT 0;');
    }
    const pendingInvites = this.db.prepare(`
      SELECT ae.email, ae.created_at AS createdAt
      FROM allowed_emails ae LEFT JOIN users u ON u.email = ae.email COLLATE NOCASE
      WHERE u.id IS NULL
    `).all();
    const activeSprint = this.getActiveSprint();
    for (const invite of pendingInvites) {
      const id = `invited_${randomBytes(16).toString('hex')}`;
      this.db.prepare(`
        INSERT INTO users (id, email, name, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)
      `).run(id, invite.email, invite.email.split('@')[0], invite.createdAt, invite.createdAt);
      if (activeSprint) {
        this.db.prepare('INSERT OR IGNORE INTO sprint_members (sprint_id, user_id, joined_at) VALUES (?, ?, ?)')
          .run(activeSprint.id, id, this.nowIso());
      }
    }
    let removedMemberships = 0;
    if (activeSprint) {
      removedMemberships = Number(this.db.prepare(`
        DELETE FROM sprint_members
        WHERE sprint_id = ? AND NOT EXISTS (
          SELECT 1 FROM users u JOIN allowed_emails ae ON ae.email = u.email COLLATE NOCASE
          WHERE u.id = sprint_members.user_id
        )
      `).run(activeSprint.id).changes);
    }
    if (activeSprint && (pendingInvites.length || removedMemberships)) this.queueSheetSync(activeSprint.id);
  }

  close() {
    this.db?.close();
    this.db = null;
  }

  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  nowIso() {
    return this.now().toISOString();
  }

  loginGoogleUser(profile) {
    const timestamp = this.nowIso();
    return this.transaction(() => {
      const existing = this.db.prepare(`
        SELECT id FROM users WHERE google_subject = ? OR email = ? COLLATE NOCASE
        ORDER BY google_subject = ? DESC LIMIT 1
      `).get(profile.id, profile.email, profile.id);
      const userId = existing?.id ?? profile.id;
      if (existing) {
        this.db.prepare(`
          UPDATE users SET google_subject = ?, email = ?, name = ?, avatar_url = ?, last_login_at = ? WHERE id = ?
        `).run(profile.id, profile.email, profile.name, profile.avatarUrl ?? null, timestamp, userId);
      } else {
        this.db.prepare(`
          INSERT INTO users (id, google_subject, email, name, avatar_url, created_at, last_login_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(userId, profile.id, profile.email, profile.name, profile.avatarUrl ?? null, timestamp, timestamp);
      }

      const activeSprint = this.getActiveSprint();
      if (activeSprint) {
        this.db.prepare(`
          INSERT OR IGNORE INTO sprint_members (sprint_id, user_id, joined_at) VALUES (?, ?, ?)
        `).run(activeSprint.id, userId, timestamp);
        this.queueSheetSync(activeSprint.id);
      }
      return this.getUser(userId);
    });
  }

  isEmailAllowed(email) {
    return Boolean(this.db.prepare('SELECT 1 FROM allowed_emails WHERE email = ? COLLATE NOCASE').get(email));
  }

  allowEmail(email) {
    const normalized = email.toLocaleLowerCase();
    const timestamp = this.nowIso();
    return this.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO allowed_emails (email, created_at) VALUES (?, ?)')
        .run(normalized, timestamp);
      let user = this.db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(normalized);
      if (!user) {
        const id = `invited_${randomBytes(16).toString('hex')}`;
        this.db.prepare(`
          INSERT INTO users (id, email, name, created_at, last_login_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(id, normalized, normalized.split('@')[0], timestamp, timestamp);
        user = { id };
      } else {
        this.db.prepare('UPDATE users SET reminders_enabled = 1 WHERE id = ?').run(user.id);
      }
      const activeSprint = this.getActiveSprint();
      if (activeSprint) {
        this.db.prepare('INSERT OR IGNORE INTO sprint_members (sprint_id, user_id, joined_at) VALUES (?, ?, ?)')
          .run(activeSprint.id, user.id, timestamp);
        this.queueSheetSync(activeSprint.id);
      }
      return row(this.db.prepare(`
        SELECT ae.email, ae.created_at AS createdAt, u.id AS userId, u.name AS userName,
               u.google_subject IS NOT NULL AS registered
        FROM allowed_emails ae JOIN users u ON u.email = ae.email COLLATE NOCASE
        WHERE ae.email = ? COLLATE NOCASE
      `).get(normalized));
    });
  }

  removeAllowedEmail(email) {
    return this.transaction(() => {
      const user = this.db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(email);
      if (user) {
        this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
        this.db.prepare('UPDATE users SET reminders_enabled = 0 WHERE id = ?').run(user.id);
        const activeSprint = this.getActiveSprint();
        if (activeSprint) {
          this.db.prepare('DELETE FROM sprint_members WHERE sprint_id = ? AND user_id = ?')
            .run(activeSprint.id, user.id);
          this.queueSheetSync(activeSprint.id);
        }
      }
      return Boolean(this.db.prepare('DELETE FROM allowed_emails WHERE email = ? COLLATE NOCASE').run(email).changes);
    });
  }

  listAllowedEmails() {
    return rows(this.db.prepare(`
      SELECT ae.email, ae.created_at AS createdAt, u.id AS userId, u.name AS userName,
             u.google_subject IS NOT NULL AS registered
      FROM allowed_emails ae LEFT JOIN users u ON u.email = ae.email COLLATE NOCASE
      ORDER BY ae.email COLLATE NOCASE
    `).all());
  }

  getReminderTime() {
    return this.db.prepare("SELECT value FROM app_settings WHERE key = 'reminder_time'").get()?.value ?? '20:00';
  }

  setReminderTime(value) {
    this.db.prepare(`
      INSERT INTO app_settings (key, value) VALUES ('reminder_time', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(value);
    return this.getReminderTime();
  }

  getReminderSettings() {
    const get = (key, fallback) => this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value ?? fallback;
    return {
      time: this.getReminderTime(),
      emailDailyEnabled: get('email_daily_enabled', 'true') === 'true',
      discordDailyEnabled: get('discord_daily_enabled', 'true') === 'true',
    };
  }

  setReminderSettings({ time, emailDailyEnabled, discordDailyEnabled }) {
    this.transaction(() => {
      this.setReminderTime(time);
      for (const [key, enabled] of Object.entries({ email_daily_enabled: emailDailyEnabled, discord_daily_enabled: discordDailyEnabled })) {
        this.db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .run(key, enabled ? 'true' : 'false');
      }
    });
    return this.getReminderSettings();
  }

  getUser(id) {
    return row(this.db.prepare(`
      SELECT id, email, name, avatar_url AS avatarUrl,
             reminders_enabled AS remindersEnabled, google_subject IS NOT NULL AS registered,
             created_at AS createdAt, last_login_at AS lastLoginAt
      FROM users WHERE id = ?
    `).get(id));
  }

  listUsers() {
    return rows(this.db.prepare(`
      SELECT users.id, users.email, users.name, users.avatar_url AS avatarUrl,
             users.reminders_enabled AS remindersEnabled, users.google_subject IS NOT NULL AS registered,
             users.created_at AS createdAt, users.last_login_at AS lastLoginAt
      FROM users JOIN allowed_emails ae ON ae.email = users.email COLLATE NOCASE
      ORDER BY users.name COLLATE NOCASE, users.email COLLATE NOCASE
    `).all());
  }

  setUserReminders(id, enabled) {
    const result = this.db.prepare('UPDATE users SET reminders_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    if (!result.changes) return null;
    if (enabled) {
      const active = this.getActiveSprint();
      if (active) {
        this.db.prepare('INSERT OR IGNORE INTO sprint_members (sprint_id, user_id, joined_at) VALUES (?, ?, ?)')
          .run(active.id, id, this.nowIso());
        this.queueSheetSync(active.id);
      }
    }
    return this.getUser(id);
  }

  createSession(userId, maxAgeSeconds = 7 * 24 * 60 * 60) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(this.now().getTime() + maxAgeSeconds * 1000).toISOString();
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(tokenHash(token), userId, expiresAt);
    return { token, expiresAt };
  }

  sessionForToken(token) {
    if (!token) return null;
    const session = row(this.db.prepare(`
      SELECT s.token_hash AS tokenHash, s.expires_at AS expiresAt, s.admin_until AS adminUntil,
             u.id, u.email, u.name, u.avatar_url AS avatarUrl, u.reminders_enabled AS remindersEnabled
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
    `).get(tokenHash(token)));
    if (!session) return null;
    if (session.expiresAt <= this.nowIso()) {
      this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(session.tokenHash);
      return null;
    }
    return session;
  }

  deleteSession(token) {
    if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
  }

  createAdminSession(maxAgeSeconds = 60 * 60) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(this.now().getTime() + maxAgeSeconds * 1000).toISOString();
    this.db.prepare('INSERT INTO admin_sessions (token_hash, expires_at) VALUES (?, ?)')
      .run(tokenHash(token), expiresAt);
    return { token, expiresAt };
  }

  adminSessionForToken(token) {
    if (!token) return null;
    const session = row(this.db.prepare(`
      SELECT token_hash AS tokenHash, expires_at AS expiresAt
      FROM admin_sessions WHERE token_hash = ?
    `).get(tokenHash(token)));
    if (!session) return null;
    if (session.expiresAt <= this.nowIso()) {
      this.db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(session.tokenHash);
      return null;
    }
    return session;
  }

  elevateSession(token, seconds = 60 * 60) {
    const adminUntil = new Date(this.now().getTime() + seconds * 1000).toISOString();
    const result = this.db.prepare('UPDATE sessions SET admin_until = ? WHERE token_hash = ?')
      .run(adminUntil, tokenHash(token));
    return result.changes ? adminUntil : null;
  }

  getActiveSprint() {
    return row(this.db.prepare(`
      SELECT id, name, starts_at AS startsAt, ends_at AS endsAt, sheet_id AS sheetId, sheet_title AS sheetTitle
      FROM sprints WHERE ends_at IS NULL LIMIT 1
    `).get());
  }

  getSprint(id) {
    return row(this.db.prepare(`
      SELECT id, name, starts_at AS startsAt, ends_at AS endsAt, sheet_id AS sheetId, sheet_title AS sheetTitle
      FROM sprints WHERE id = ?
    `).get(id));
  }

  listSprints() {
    return rows(this.db.prepare(`
      SELECT id, name, starts_at AS startsAt, ends_at AS endsAt, sheet_id AS sheetId, sheet_title AS sheetTitle
      FROM sprints ORDER BY id DESC
    `).all());
  }

  createSprint(name) {
    const timestamp = this.nowIso();
    return this.transaction(() => {
      const previous = this.getActiveSprint();
      if (previous) {
        this.db.prepare('UPDATE sprints SET ends_at = ? WHERE id = ?').run(timestamp, previous.id);
        this.queueSheetSync(previous.id);
      }
      const result = this.db.prepare('INSERT INTO sprints (name, starts_at) VALUES (?, ?)').run(name, timestamp);
      const id = Number(result.lastInsertRowid);
      this.db.prepare(`
        INSERT INTO sprint_members (sprint_id, user_id, joined_at)
        SELECT ?, u.id, ? FROM users u
        JOIN allowed_emails ae ON ae.email = u.email COLLATE NOCASE
        WHERE u.reminders_enabled = 1
      `).run(id, timestamp);
      this.queueSheetSync(id);
      return this.getSprint(id);
    });
  }

  setSprintSheet(id, sheetId, sheetTitle) {
    this.db.prepare('UPDATE sprints SET sheet_id = ?, sheet_title = ? WHERE id = ?').run(sheetId, sheetTitle, id);
  }

  upsertToday(userId, answers) {
    const sprint = this.getActiveSprint();
    if (!sprint) return { kind: 'no-sprint' };
    const localDate = bangkokNow(this.now()).date;
    const timestamp = this.nowIso();
    return this.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO sprint_members (sprint_id, user_id, joined_at) VALUES (?, ?, ?)')
        .run(sprint.id, userId, timestamp);
      this.db.prepare(`
        INSERT INTO submissions (sprint_id, user_id, local_date, done, todo, problem, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(sprint_id, user_id, local_date) DO UPDATE SET
          done = excluded.done, todo = excluded.todo, problem = excluded.problem, updated_at = excluded.updated_at
      `).run(sprint.id, userId, localDate, answers.done, answers.todo, answers.problem, timestamp, timestamp);
      this.queueSheetSync(sprint.id);
      return { kind: 'ok', submission: this.getSubmission(sprint.id, userId, localDate) };
    });
  }

  getSubmission(sprintId, userId, localDate) {
    return row(this.db.prepare(`
      SELECT id, sprint_id AS sprintId, user_id AS userId, local_date AS localDate,
             done, todo, problem, created_at AS createdAt, updated_at AS updatedAt
      FROM submissions WHERE sprint_id = ? AND user_id = ? AND local_date = ?
    `).get(sprintId, userId, localDate));
  }

  dashboard(sprintId, localDate, currentUserId) {
    const sprint = sprintId ? this.getSprint(sprintId) : this.getActiveSprint();
    if (!sprint) return { sprint: null, date: localDate, members: [], submissions: [], ownSubmission: null };
    const members = rows(this.db.prepare(`
      SELECT u.id, u.email, u.name, u.avatar_url AS avatarUrl, u.reminders_enabled AS remindersEnabled
      FROM sprint_members sm JOIN users u ON u.id = sm.user_id
      WHERE sm.sprint_id = ? ORDER BY u.name COLLATE NOCASE, u.email COLLATE NOCASE
    `).all(sprint.id));
    const submissions = rows(this.db.prepare(`
      SELECT s.id, s.sprint_id AS sprintId, s.user_id AS userId, s.local_date AS localDate,
             s.done, s.todo, s.problem, s.created_at AS createdAt, s.updated_at AS updatedAt,
             u.name AS userName, u.email AS userEmail, u.avatar_url AS avatarUrl
      FROM submissions s JOIN users u ON u.id = s.user_id
      WHERE s.sprint_id = ? AND s.local_date = ? ORDER BY u.name COLLATE NOCASE
    `).all(sprint.id, localDate));
    return {
      sprint,
      date: localDate,
      members,
      submissions,
      ownSubmission: submissions.find((submission) => submission.userId === currentUserId) ?? null,
    };
  }

  sprintDataset(sprintId) {
    const sprint = this.getSprint(sprintId);
    if (!sprint) return null;
    const members = rows(this.db.prepare(`
      SELECT u.id, u.email, u.name
      FROM sprint_members sm JOIN users u ON u.id = sm.user_id
      WHERE sm.sprint_id = ? ORDER BY sm.joined_at, u.email COLLATE NOCASE
    `).all(sprintId));
    const submissions = rows(this.db.prepare(`
      SELECT user_id AS userId, local_date AS localDate, done, todo, problem
      FROM submissions WHERE sprint_id = ? ORDER BY local_date, user_id
    `).all(sprintId));
    const finalInstant = sprint.endsAt ?? this.nowIso();
    return {
      sprint,
      members,
      submissions,
      startDate: isoDateFromInstant(sprint.startsAt),
      endDate: isoDateFromInstant(finalInstant),
    };
  }

  queueSheetSync(sprintId) {
    const timestamp = this.nowIso();
    this.db.prepare(`
      INSERT INTO sheet_sync_jobs (sprint_id, status, attempts, next_attempt_at)
      VALUES (?, 'pending', 0, ?)
      ON CONFLICT(sprint_id) DO UPDATE SET
        status = 'pending', attempts = 0, next_attempt_at = excluded.next_attempt_at,
        completed_at = NULL, last_error = NULL
    `).run(sprintId, timestamp);
  }

  dueSheetJobs() {
    return rows(this.db.prepare(`
      SELECT sprint_id AS sprintId, status, attempts, next_attempt_at AS nextAttemptAt,
             last_attempt_at AS lastAttemptAt, completed_at AS completedAt, last_error AS lastError
      FROM sheet_sync_jobs WHERE status != 'complete' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 10
    `).all(this.nowIso()));
  }

  markSheetSyncComplete(sprintId) {
    const timestamp = this.nowIso();
    this.db.prepare(`
      UPDATE sheet_sync_jobs SET status = 'complete', completed_at = ?, last_attempt_at = ?, last_error = NULL
      WHERE sprint_id = ?
    `).run(timestamp, timestamp, sprintId);
  }

  markSheetSyncFailed(sprintId, error) {
    const timestamp = this.nowIso();
    const nextAttempt = new Date(this.now().getTime() + 15 * 60 * 1000).toISOString();
    this.db.prepare(`
      UPDATE sheet_sync_jobs SET status = 'error', attempts = attempts + 1,
        last_attempt_at = ?, next_attempt_at = ?, last_error = ? WHERE sprint_id = ?
    `).run(timestamp, nextAttempt, String(error).slice(0, 1000), sprintId);
  }

  retryAllSheetSyncs() {
    this.db.prepare(`
      UPDATE sheet_sync_jobs SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL
    `).run(this.nowIso());
  }

  sheetSyncStatus() {
    return rows(this.db.prepare(`
      SELECT j.sprint_id AS sprintId, s.name AS sprintName, j.status, j.attempts,
             j.last_attempt_at AS lastAttemptAt, j.completed_at AS completedAt, j.last_error AS lastError
      FROM sheet_sync_jobs j JOIN sprints s ON s.id = j.sprint_id ORDER BY j.sprint_id DESC
    `).all());
  }

  reminderCandidates(sprintId, localDate, { automatic = false } = {}) {
    return rows(this.db.prepare(`
      SELECT u.id, u.email, u.name, rd.attempts, rd.last_attempt_at AS lastAttemptAt,
             rd.sent_at AS sentAt, COALESCE(rd.sent_count, 0) AS sentCount,
             COALESCE(rd.automatic_sent, 0) AS automaticSent, rd.last_error AS lastError
      FROM sprint_members sm JOIN users u ON u.id = sm.user_id
      LEFT JOIN submissions s ON s.sprint_id = sm.sprint_id AND s.user_id = sm.user_id AND s.local_date = ?
      LEFT JOIN reminder_deliveries rd ON rd.sprint_id = sm.sprint_id AND rd.user_id = sm.user_id AND rd.local_date = ?
      WHERE sm.sprint_id = ? AND u.reminders_enabled = 1 AND s.id IS NULL
        AND COALESCE(rd.sent_count, 0) < 2
        AND (? = 0 OR COALESCE(rd.automatic_sent, 0) = 0)
      ORDER BY u.email COLLATE NOCASE
    `).all(localDate, localDate, sprintId, automatic ? 1 : 0));
  }

  startReminder(sprintId, userId, localDate) {
    const timestamp = this.nowIso();
    this.db.prepare(`
      INSERT INTO reminder_deliveries (sprint_id, user_id, local_date, attempts, last_attempt_at)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(sprint_id, user_id, local_date) DO UPDATE SET
        attempts = attempts + 1, last_attempt_at = excluded.last_attempt_at, last_error = NULL
    `).run(sprintId, userId, localDate, timestamp);
  }

  markReminderSent(sprintId, userId, localDate, { automatic = false } = {}) {
    this.db.prepare(`
      UPDATE reminder_deliveries SET sent_at = ?, sent_count = sent_count + 1,
        automatic_sent = CASE WHEN ? = 1 THEN 1 ELSE automatic_sent END, last_error = NULL
      WHERE sprint_id = ? AND user_id = ? AND local_date = ?
    `).run(this.nowIso(), automatic ? 1 : 0, sprintId, userId, localDate);
  }

  markReminderFailed(sprintId, userId, localDate, error) {
    this.db.prepare(`
      UPDATE reminder_deliveries SET last_error = ?
      WHERE sprint_id = ? AND user_id = ? AND local_date = ?
    `).run(String(error).slice(0, 1000), sprintId, userId, localDate);
  }

  reminderStatus() {
    return rows(this.db.prepare(`
      SELECT rd.sprint_id AS sprintId, s.name AS sprintName, rd.local_date AS localDate,
             rd.user_id AS userId, u.email, rd.attempts, rd.last_attempt_at AS lastAttemptAt,
             rd.sent_at AS sentAt, rd.sent_count AS sentCount,
             rd.automatic_sent AS automaticSent, rd.last_error AS lastError
      FROM reminder_deliveries rd
      JOIN users u ON u.id = rd.user_id JOIN sprints s ON s.id = rd.sprint_id
      ORDER BY rd.local_date DESC, u.email COLLATE NOCASE LIMIT 100
    `).all());
  }

  missingReminderMembers(sprintId, localDate) {
    return rows(this.db.prepare(`
      SELECT u.id, u.email, u.name
      FROM sprint_members sm JOIN users u ON u.id = sm.user_id
      LEFT JOIN submissions s ON s.sprint_id = sm.sprint_id AND s.user_id = sm.user_id AND s.local_date = ?
      WHERE sm.sprint_id = ? AND u.reminders_enabled = 1 AND s.id IS NULL
      ORDER BY u.email COLLATE NOCASE
    `).all(localDate, sprintId));
  }

  discordDelivery(sprintId, localDate) {
    return row(this.db.prepare(`
      SELECT sprint_id AS sprintId, local_date AS localDate, attempts, last_attempt_at AS lastAttemptAt,
             sent_at AS sentAt, automatic_sent AS automaticSent, last_error AS lastError
      FROM discord_deliveries WHERE sprint_id = ? AND local_date = ?
    `).get(sprintId, localDate));
  }

  startDiscordDelivery(sprintId, localDate) {
    this.db.prepare(`
      INSERT INTO discord_deliveries (sprint_id, local_date, attempts, last_attempt_at)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(sprint_id, local_date) DO UPDATE SET
        attempts = attempts + 1, last_attempt_at = excluded.last_attempt_at, last_error = NULL
    `).run(sprintId, localDate, this.nowIso());
  }

  markDiscordSent(sprintId, localDate, { automatic = false } = {}) {
    this.db.prepare(`
      UPDATE discord_deliveries SET sent_at = ?, automatic_sent = CASE WHEN ? = 1 THEN 1 ELSE automatic_sent END,
        last_error = NULL WHERE sprint_id = ? AND local_date = ?
    `).run(this.nowIso(), automatic ? 1 : 0, sprintId, localDate);
  }

  markDiscordFailed(sprintId, localDate, error) {
    this.db.prepare('UPDATE discord_deliveries SET last_error = ? WHERE sprint_id = ? AND local_date = ?')
      .run(String(error).slice(0, 1000), sprintId, localDate);
  }

  markDiscordAutomaticComplete(sprintId, localDate) {
    this.db.prepare(`
      INSERT INTO discord_deliveries (sprint_id, local_date, automatic_sent, sent_at)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(sprint_id, local_date) DO UPDATE SET automatic_sent = 1, sent_at = excluded.sent_at
    `).run(sprintId, localDate, this.nowIso());
  }

  discordDeliveryStatus() {
    return rows(this.db.prepare(`
      SELECT dd.sprint_id AS sprintId, s.name AS sprintName, dd.local_date AS localDate, dd.attempts,
             dd.last_attempt_at AS lastAttemptAt, dd.sent_at AS sentAt, dd.automatic_sent AS automaticSent,
             dd.last_error AS lastError
      FROM discord_deliveries dd JOIN sprints s ON s.id = dd.sprint_id
      ORDER BY dd.local_date DESC LIMIT 100
    `).all());
  }
}
