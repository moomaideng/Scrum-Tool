import { bangkokNow } from './time.js';

export class StandupScheduler {
  constructor({ store, sheetSync, mailer, discordNotifier = { enabled: false }, applicationUrl, now = () => new Date(), logger = console }) {
    this.store = store;
    this.sheetSync = sheetSync;
    this.mailer = mailer;
    this.discordNotifier = discordNotifier;
    this.applicationUrl = applicationUrl;
    this.now = now;
    this.logger = logger;
    this.timer = null;
    this.running = false;
    this.lastQueuedDate = null;
  }

  start() {
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), 60_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce() {
    if (this.running) return;
    this.running = true;
    try {
      const local = bangkokNow(this.now());
      const sprint = this.store.getActiveSprint();
      if (sprint && this.lastQueuedDate !== local.date) {
        this.store.queueSheetSync(sprint.id);
        this.lastQueuedDate = local.date;
      }
      if (this.sheetSync.enabled) await this.runSheetJobs();
      const settings = this.store.getReminderSettings();
      const phase = reminderPhase(local, settings);
      if (sprint && phase && settings.emailDailyEnabled && this.mailer.enabled) {
        await this.runReminders(sprint, local.date, { automaticPhase: phase });
      }
      if (sprint && phase && settings.discordDailyEnabled && this.discordNotifier.enabled) {
        await this.runDiscordReminder(sprint, local.date, { automaticPhase: phase });
      }
    } finally {
      this.running = false;
    }
  }

  async runSheetJobs() {
    for (const job of this.store.dueSheetJobs()) {
      try {
        await this.sheetSync.syncSprint(job.sprintId);
        this.store.markSheetSyncComplete(job.sprintId);
      } catch (error) {
        this.store.markSheetSyncFailed(job.sprintId, error.message);
        this.logger.error('Standup Sheet sync failed', error);
      }
    }
  }

  async runReminders(sprint, localDate, { automaticPhase = null } = {}) {
    const result = { sent: 0, failed: 0 };
    const automatic = Boolean(automaticPhase);
    const responseRate = this.store.responseRate(sprint.id, localDate);
    for (const user of this.store.reminderCandidates(sprint.id, localDate, { automaticPhase })) {
      if (automatic && user.lastAttemptAt && this.now().getTime() - new Date(user.lastAttemptAt).getTime() < 15 * 60 * 1000) continue;
      this.store.startReminder(sprint.id, user.id, localDate);
      try {
        await this.mailer.send({ user, sprint, localDate, applicationUrl: this.applicationUrl, reminderKind: automaticPhase ?? 'manual', responseRate });
        this.store.markReminderSent(sprint.id, user.id, localDate, { automaticPhase });
        result.sent += 1;
      } catch (error) {
        this.store.markReminderFailed(sprint.id, user.id, localDate, error.message);
        this.logger.error('Standup reminder failed', error);
        result.failed += 1;
      }
    }
    return result;
  }

  async sendRemindersNow() {
    if (this.running) return { busy: true, sent: 0, failed: 0 };
    this.running = true;
    try {
      const sprint = this.store.getActiveSprint();
      if (!sprint) return { noSprint: true, sent: 0, failed: 0 };
      const result = await this.runReminders(sprint, bangkokNow(this.now()).date);
      return { ...result, busy: false, noSprint: false };
    } finally {
      this.running = false;
    }
  }

  async runDiscordReminder(sprint, localDate, { automaticPhase = null } = {}) {
    const automatic = Boolean(automaticPhase);
    const previous = this.store.discordDelivery(sprint.id, localDate);
    if (automatic && (automaticPhase === 'first' ? previous?.automaticFirstSent : previous?.automaticSecondSent)) return { sent: false, skipped: true };
    if (automatic && previous?.lastAttemptAt && this.now().getTime() - new Date(previous.lastAttemptAt).getTime() < 15 * 60 * 1000) {
      return { sent: false, skipped: true };
    }
    const users = this.store.missingReminderMembers(sprint.id, localDate);
    if (!users.length) {
      if (automatic) this.store.markDiscordAutomaticComplete(sprint.id, localDate, automaticPhase);
      return { sent: false, noMissing: true };
    }
    this.store.startDiscordDelivery(sprint.id, localDate);
    try {
      await this.discordNotifier.send({ sprint, localDate, users, applicationUrl: this.applicationUrl, reminderKind: automaticPhase ?? 'manual', responseRate: this.store.responseRate(sprint.id, localDate) });
      this.store.markDiscordSent(sprint.id, localDate, { automaticPhase });
      return { sent: true, missing: users.length };
    } catch (error) {
      this.store.markDiscordFailed(sprint.id, localDate, error.message);
      this.logger.error('Standup Discord reminder failed', error);
      return { sent: false, failed: true, missing: users.length };
    }
  }

  async sendDiscordReminderNow() {
    if (this.running) return { busy: true, sent: false };
    this.running = true;
    try {
      const sprint = this.store.getActiveSprint();
      if (!sprint) return { noSprint: true, sent: false };
      return { ...await this.runDiscordReminder(sprint, bangkokNow(this.now()).date), busy: false, noSprint: false };
    } finally {
      this.running = false;
    }
  }
}

function reminderPhase(local, settings) {
  const minutes = local.hour * 60 + local.minute;
  const timeToMinutes = (value) => value.split(':').map(Number).reduce((hour, minute) => hour * 60 + minute);
  if (minutes >= timeToMinutes(settings.time)) return 'second';
  if (minutes >= timeToMinutes(settings.firstTime)) return 'first';
  return null;
}
