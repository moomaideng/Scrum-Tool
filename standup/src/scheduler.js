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
      const [hour, minute] = this.store.getReminderTime().split(':').map(Number);
      const reminderTimeReached = local.hour * 60 + local.minute >= hour * 60 + minute;
      const settings = this.store.getReminderSettings();
      if (sprint && settings.emailDailyEnabled && this.mailer.enabled && reminderTimeReached) {
        await this.runReminders(sprint, local.date);
      }
      if (sprint && settings.discordDailyEnabled && this.discordNotifier.enabled && reminderTimeReached) {
        await this.runDiscordReminder(sprint, local.date);
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

  async runReminders(sprint, localDate, { force = false } = {}) {
    const result = { sent: 0, failed: 0 };
    const automatic = !force;
    for (const user of this.store.reminderCandidates(sprint.id, localDate, { automatic })) {
      if (!force && user.lastAttemptAt && this.now().getTime() - new Date(user.lastAttemptAt).getTime() < 15 * 60 * 1000) continue;
      this.store.startReminder(sprint.id, user.id, localDate);
      try {
        await this.mailer.send({ user, sprint, localDate, applicationUrl: this.applicationUrl });
        this.store.markReminderSent(sprint.id, user.id, localDate, { automatic });
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
      const result = await this.runReminders(sprint, bangkokNow(this.now()).date, { force: true });
      return { ...result, busy: false, noSprint: false };
    } finally {
      this.running = false;
    }
  }

  async runDiscordReminder(sprint, localDate, { force = false } = {}) {
    const automatic = !force;
    const previous = this.store.discordDelivery(sprint.id, localDate);
    if (automatic && previous?.automaticSent) return { sent: false, skipped: true };
    if (automatic && previous?.lastAttemptAt && this.now().getTime() - new Date(previous.lastAttemptAt).getTime() < 15 * 60 * 1000) {
      return { sent: false, skipped: true };
    }
    const users = this.store.missingReminderMembers(sprint.id, localDate);
    if (!users.length) {
      if (automatic) this.store.markDiscordAutomaticComplete(sprint.id, localDate);
      return { sent: false, noMissing: true };
    }
    this.store.startDiscordDelivery(sprint.id, localDate);
    try {
      await this.discordNotifier.send({ sprint, localDate, users, applicationUrl: this.applicationUrl });
      this.store.markDiscordSent(sprint.id, localDate, { automatic });
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
      return { ...await this.runDiscordReminder(sprint, bangkokNow(this.now()).date, { force: true }), busy: false, noSprint: false };
    } finally {
      this.running = false;
    }
  }
}
