import nodemailer from 'nodemailer';

export class ReminderMailer {
  constructor(config, { transport } = {}) {
    this.config = config;
    this.enabled = Boolean(config.host && config.user && config.password && config.from);
    this.transport = transport ?? (this.enabled ? nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.password },
    }) : null);
  }

  async send({ user, sprint, localDate, applicationUrl }) {
    if (!this.enabled) throw new Error('Reminder email is not configured.');
    await this.transport.sendMail({
      from: this.config.from,
      to: user.email,
      subject: `Standup reminder — ${sprint.name} — ${localDate}`,
      text: `Hi ${user.name},\n\nYour standup for ${localDate} has not been submitted yet.\n\nAdd it here: ${applicationUrl}\n\nDone · To do · Problem`,
      html: `<p>Hi ${escapeHtml(user.name)},</p><p>Your standup for <strong>${escapeHtml(localDate)}</strong> has not been submitted yet.</p><p><a href="${escapeHtml(applicationUrl)}">Add your standup</a></p><p>Done · To do · Problem</p>`,
    });
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}
