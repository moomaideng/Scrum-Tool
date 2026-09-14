import express from 'express';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { OAuth2Client } from 'google-auth-library';
import { readConfig } from './config.js';
import { StandupStore } from './store.js';
import { GoogleSheetSync } from './sheet.js';
import { DiscordNotifier, ReminderMailer } from './integrations.js';
import { StandupScheduler } from './scheduler.js';
import { bangkokNow } from './time.js';

const ADMIN_PASSWORD = 'admin';

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => {
    const separator = part.indexOf('=');
    if (separator === -1) return ['', ''];
    return [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())];
  }).filter(([key]) => key));
}

function sessionCookie(config, token, maxAge = 7 * 24 * 60 * 60) {
  const secure = config.appOrigin.startsWith('https://') ? '; Secure' : '';
  return `standup_session=${encodeURIComponent(token)}; Path=${config.basePath}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function clearSessionCookie(config) {
  const secure = config.appOrigin.startsWith('https://') ? '; Secure' : '';
  return `standup_session=; Path=${config.basePath}; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function adminCookie(config, token, maxAge = 60 * 60) {
  const secure = config.appOrigin.startsWith('https://') ? '; Secure' : '';
  return `standup_admin=${encodeURIComponent(token)}; Path=${config.basePath}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function safeDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? null : value;
}

function answer(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizedEmail(value) {
  const email = answer(value).toLocaleLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export async function createStandupApplication(options = {}) {
  const config = options.config ?? readConfig();
  const store = options.store ?? new StandupStore(config.dataDirectory);
  if (!options.store) await store.initialize();
  const googleClient = options.googleClient ?? new OAuth2Client(config.googleClientId || undefined);
  const sheetSync = options.sheetSync ?? new GoogleSheetSync({
    serviceAccountBase64: config.googleServiceAccountBase64,
    serviceAccountFile: config.googleServiceAccountFile,
    spreadsheetId: config.googleSpreadsheetId,
  }, store);
  const mailer = options.mailer ?? new ReminderMailer(config.smtp);
  const discordNotifier = options.discordNotifier ?? new DiscordNotifier({ webhookUrl: config.discordWebhookUrl });
  const scheduler = options.scheduler ?? new StandupScheduler({
    store,
    sheetSync,
    mailer,
    discordNotifier,
    applicationUrl: `${config.appOrigin}${config.basePath}/`,
  });
  const app = express();
  const adminAttempts = new Map();

  app.disable('x-powered-by');
  app.enable('strict routing');
  app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '32kb' }));
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));

  function loadSession(req, res, next) {
    const token = parseCookies(req.get('cookie')).standup_session;
    const session = store.sessionForToken(token);
    if (!session) return res.status(401).json({ message: 'Please sign in with Google.' });
    req.standupToken = token;
    req.standupSession = session;
    next();
  }

  function requireSameOrigin(req, res, next) {
    if (req.get('origin') !== config.appOrigin) {
      return res.status(403).json({ message: 'This request did not come from the Standup application.' });
    }
    next();
  }

  function requireAdmin(req, res, next) {
    const token = parseCookies(req.get('cookie')).standup_admin;
    const session = store.adminSessionForToken(token);
    if (!session) {
      return res.status(403).json({ message: 'Admin password verification is required.' });
    }
    req.standupAdminToken = token;
    next();
  }

  app.get(`${config.basePath}/health`, (req, res) => {
    res.json({ status: 'ok', sheets: sheetSync.enabled ? 'configured' : 'disabled', email: mailer.enabled ? 'configured' : 'disabled', discord: discordNotifier.enabled ? 'configured' : 'disabled' });
  });

  app.get(`${config.basePath}/api/config`, (req, res) => {
    res.json({
      googleClientId: config.googleClientId,
      googleLoginUri: `${config.appOrigin}${config.basePath}/auth/google`,
    });
  });

  app.post(`${config.basePath}/auth/google`, async (req, res) => {
    const cookies = parseCookies(req.get('cookie'));
    const csrfBody = answer(req.body?.g_csrf_token);
    const csrfCookie = cookies.g_csrf_token ?? '';
    if (!csrfBody || !csrfCookie || csrfBody !== csrfCookie) {
      return res.redirect(303, `${config.basePath}/?auth_error=csrf`);
    }
    if (!config.googleClientId) return res.redirect(303, `${config.basePath}/?auth_error=configuration`);
    try {
      const ticket = await googleClient.verifyIdToken({ idToken: req.body?.credential, audience: config.googleClientId });
      const profile = ticket.getPayload();
      if (!profile?.sub || !profile.email || profile.email_verified !== true) throw new Error('The Google email is not verified.');
      if (!store.isEmailAllowed(profile.email)) {
        return res.redirect(303, `${config.basePath}/?auth_error=not_allowed`);
      }
      const user = store.loginGoogleUser({
        id: profile.sub,
        email: profile.email,
        name: answer(profile.name) || profile.email.split('@')[0],
        avatarUrl: profile.picture ?? null,
      });
      const session = store.createSession(user.id);
      res.setHeader('Set-Cookie', sessionCookie(config, session.token));
      return res.redirect(303, `${config.basePath}/`);
    } catch (error) {
      console.error('Google sign-in failed', error);
      return res.redirect(303, `${config.basePath}/?auth_error=google`);
    }
  });

  app.post(`${config.basePath}/api/logout`, loadSession, requireSameOrigin, (req, res) => {
    store.deleteSession(req.standupToken);
    res.setHeader('Set-Cookie', clearSessionCookie(config));
    res.status(204).end();
  });

  app.get(`${config.basePath}/api/me`, loadSession, (req, res) => {
    const session = req.standupSession;
    res.json({
      user: {
        id: session.id,
        email: session.email,
        name: session.name,
        avatarUrl: session.avatarUrl,
        remindersEnabled: Boolean(session.remindersEnabled),
      },
      canAdmin: true,
      isAdmin: Boolean(session.adminUntil && session.adminUntil > new Date().toISOString()),
    });
  });

  app.get(`${config.basePath}/api/dashboard`, loadSession, (req, res) => {
    const today = bangkokNow().date;
    const selectedDate = req.query.date ? safeDate(req.query.date) : today;
    if (!selectedDate || selectedDate > today) return res.status(400).json({ message: 'Choose today or an earlier valid date.' });
    const selectedSprintId = req.query.sprintId ? Number(req.query.sprintId) : null;
    if (req.query.sprintId && (!Number.isSafeInteger(selectedSprintId) || selectedSprintId < 1)) {
      return res.status(400).json({ message: 'Choose a valid sprint.' });
    }
    const dashboard = store.dashboard(selectedSprintId, selectedDate, req.standupSession.id);
    const active = store.getActiveSprint();
    res.json({
      ...dashboard,
      currentDate: today,
      sprints: store.listSprints(),
      activeSprintId: active?.id ?? null,
      canEdit: Boolean(dashboard.sprint && active?.id === dashboard.sprint.id && selectedDate === today),
    });
  });

  app.put(`${config.basePath}/api/submissions/today`, loadSession, requireSameOrigin, (req, res) => {
    const answers = {
      done: answer(req.body?.done),
      todo: answer(req.body?.todo),
      problem: answer(req.body?.problem),
    };
    if (Object.values(answers).some((value) => value.length < 1 || value.length > 2000)) {
      return res.status(400).json({ message: 'Complete all three answers using no more than 2,000 characters each. Use “-” when there is no problem.' });
    }
    const result = store.upsertToday(req.standupSession.id, answers);
    if (result.kind === 'no-sprint') return res.status(409).json({ message: 'There is no active sprint yet.' });
    void scheduler.runOnce();
    res.json(result.submission);
  });

  app.post(`${config.basePath}/api/admin/session`, requireSameOrigin, async (req, res) => {
    const key = req.ip;
    const recent = (adminAttempts.get(key) ?? []).filter((value) => Date.now() - value < 15 * 60 * 1000);
    if (recent.length >= 5) return res.status(429).json({ message: 'Too many attempts. Try again in 15 minutes.' });
    if (req.body?.password !== ADMIN_PASSWORD) {
      recent.push(Date.now());
      adminAttempts.set(key, recent);
      return res.status(401).json({ message: 'Incorrect admin password.' });
    }
    adminAttempts.delete(key);
    const session = store.createAdminSession();
    res.setHeader('Set-Cookie', adminCookie(config, session.token));
    res.json({ adminUntil: session.expiresAt });
  });

  app.get(`${config.basePath}/api/admin`, requireAdmin, (req, res) => {
    res.json({
      users: store.listUsers().map((user) => ({ ...user, remindersEnabled: Boolean(user.remindersEnabled) })),
      allowedEmails: store.listAllowedEmails(),
      sprints: store.listSprints(),
      sheet: { enabled: sheetSync.enabled, jobs: store.sheetSyncStatus() },
      email: { enabled: mailer.enabled, ...store.getReminderSettings(), deliveries: store.reminderStatus() },
      discord: { enabled: discordNotifier.enabled, dailyEnabled: store.getReminderSettings().discordDailyEnabled, deliveries: store.discordDeliveryStatus() },
    });
  });

  app.post(`${config.basePath}/api/admin/allowed-emails`, requireSameOrigin, requireAdmin, (req, res) => {
    const email = normalizedEmail(req.body?.email);
    if (!email) return res.status(400).json({ message: 'Enter a valid email address.' });
    const allowed = store.allowEmail(email);
    void scheduler.runOnce();
    res.status(201).json(allowed);
  });

  app.delete(`${config.basePath}/api/admin/allowed-emails/:email`, requireSameOrigin, requireAdmin, (req, res) => {
    const email = normalizedEmail(req.params.email);
    if (!email) return res.status(400).json({ message: 'Enter a valid email address.' });
    if (!store.removeAllowedEmail(email)) return res.status(404).json({ message: 'That email is not on the allowlist.' });
    void scheduler.runOnce();
    res.status(204).end();
  });

  app.post(`${config.basePath}/api/admin/sprints`, requireSameOrigin, requireAdmin, (req, res) => {
    const name = answer(req.body?.name).replace(/\s+/g, ' ');
    if (name.length < 1 || name.length > 60) return res.status(400).json({ message: 'Use a sprint name between 1 and 60 characters.' });
    const sprint = store.createSprint(name);
    void scheduler.runOnce();
    res.status(201).json(sprint);
  });

  app.patch(`${config.basePath}/api/admin/users/:id`, requireSameOrigin, requireAdmin, (req, res) => {
    if (typeof req.body?.remindersEnabled !== 'boolean') return res.status(400).json({ message: 'Choose whether reminders are enabled.' });
    const user = store.setUserReminders(req.params.id, req.body.remindersEnabled);
    if (!user) return res.status(404).json({ message: 'That user no longer exists.' });
    res.json({ ...user, remindersEnabled: Boolean(user.remindersEnabled) });
  });

  app.patch(`${config.basePath}/api/admin/reminders`, requireSameOrigin, requireAdmin, (req, res) => {
    const time = answer(req.body?.time);
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      return res.status(400).json({ message: 'Choose a valid reminder time.' });
    }
    if (typeof req.body?.emailDailyEnabled !== 'boolean' || typeof req.body?.discordDailyEnabled !== 'boolean') {
      return res.status(400).json({ message: 'Choose whether each daily reminder channel is enabled.' });
    }
    res.json(store.setReminderSettings({ time, emailDailyEnabled: req.body.emailDailyEnabled, discordDailyEnabled: req.body.discordDailyEnabled }));
  });

  app.post(`${config.basePath}/api/admin/reminders/send`, requireSameOrigin, requireAdmin, async (req, res) => {
    if (!mailer.enabled) return res.status(409).json({ message: 'Email is not configured.' });
    const result = await scheduler.sendRemindersNow();
    if (result.busy) return res.status(409).json({ message: 'Reminder processing is already running.' });
    if (result.noSprint) return res.status(409).json({ message: 'There is no active sprint.' });
    res.json(result);
  });

  app.post(`${config.basePath}/api/admin/discord/send`, requireSameOrigin, requireAdmin, async (req, res) => {
    if (!discordNotifier.enabled) return res.status(409).json({ message: 'Discord is not configured.' });
    const result = await scheduler.sendDiscordReminderNow();
    if (result.busy) return res.status(409).json({ message: 'Reminder processing is already running.' });
    if (result.noSprint) return res.status(409).json({ message: 'There is no active sprint.' });
    if (result.failed) return res.status(502).json({ message: 'Discord did not accept the reminder. Try again shortly.' });
    if (result.noMissing) return res.json({ ...result, message: 'Everyone has already submitted today.' });
    res.json(result);
  });

  app.post(`${config.basePath}/api/admin/sheets/retry`, requireSameOrigin, requireAdmin, (req, res) => {
    store.retryAllSheetSyncs();
    void scheduler.runOnce();
    res.status(202).json({ message: 'Sheet synchronization has been queued.' });
  });

  app.get(config.basePath, (req, res) => res.redirect(308, `${config.basePath}/`));
  app.use(config.basePath, express.static(config.publicDirectory, { index: false }));
  app.get(`${config.basePath}/privacy`, (req, res) => res.sendFile(path.join(config.publicDirectory, 'privacy.html')));
  app.get(`${config.basePath}/terms`, (req, res) => res.sendFile(path.join(config.publicDirectory, 'terms.html')));
  app.get(`${config.basePath}/{*splat}`, (req, res, next) => {
    if (req.path.startsWith(`${config.basePath}/api/`) || req.path.startsWith(`${config.basePath}/auth/`)) return next();
    res.sendFile(path.join(config.publicDirectory, 'index.html'));
  });

  app.use((req, res) => res.status(404).json({ message: 'Not found.' }));
  app.use((error, req, res, next) => {
    console.error(error);
    if (res.headersSent) return next(error);
    res.status(500).json({ message: 'Something went wrong. Please try again.' });
  });

  return { app, store, scheduler, config, sheetSync, mailer, discordNotifier };
}

async function main() {
  const application = await createStandupApplication();
  const server = application.app.listen(application.config.port, () => {
    console.log(`Scrum standup tool is listening on port ${application.config.port} at ${application.config.basePath}/`);
  });
  application.scheduler.start();
  const shutdown = () => {
    application.scheduler.stop();
    server.close(() => {
      application.store.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
