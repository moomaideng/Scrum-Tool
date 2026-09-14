import nodemailer from 'nodemailer';

const STANDUP_LINES = [
  'Tiny updates prevent giant surprises.',
  'Progress loves a short, honest status.',
  'A blocker shared is a blocker already shrinking.',
  'Three answers now, fewer mysteries later.',
  'Small steps still move the sprint forward.',
  'Today’s plot twist belongs in the Problem box.',
  'Done is worth celebrating, even when it is small.',
  'Your future teammate will thank you for this update.',
  'Keep calm and tell the team what is blocking you.',
  'A clear “To do” is a gift to tomorrow morning.',
];

const ASCII_FRIENDS = [
  ['  /\\_/\\', ' ( o.o )', '  > ^ <'].join('\n'),
  ['   .--.', '  |o_o |', '  |:_/ |', ' //   \\ \\', '(|     | )', '/\'_   _/`\\'].join('\n'),
  ['   __', ' _(  )_', '(_    _)', '  (__)  ☁'].join('\n'),
  ['  .-.', ' (•‿•)', ' /|_|\\', '  / \\'].join('\n'),
  ['  [✓]', ' /|\\', ' / \\', 'ship it!'].join('\n'),
];

function randomItem(items, random) {
  return items[Math.floor(random() * items.length)];
}

export class ReminderMailer {
  constructor(config, { transport, random = Math.random } = {}) {
    this.config = config;
    this.random = random;
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
    const line = randomItem(STANDUP_LINES, this.random);
    const ascii = randomItem(ASCII_FRIENDS, this.random);
    await this.transport.sendMail({
      from: this.config.from,
      to: user.email,
      subject: `Standup reminder — ${sprint.name} — ${localDate}`,
      text: `Hi ${user.name},\n\nYour standup for ${localDate} has not been submitted yet.\n\nAdd it here: ${applicationUrl}\n\nDone · To do · Problem\n\n${line}\n\n${ascii}`,
      html: `<p>Hi ${escapeHtml(user.name)},</p><p>Your standup for <strong>${escapeHtml(localDate)}</strong> has not been submitted yet.</p><p><a href="${escapeHtml(applicationUrl)}">Add your standup</a></p><p>Done · To do · Problem</p><div style="margin-top:24px;padding:16px;border-radius:12px;background:#f3f7f5;color:#17324d"><p style="margin:0 0 12px;font-weight:700">${escapeHtml(line)}</p><pre style="margin:0;font:14px/1.25 monospace;white-space:pre-wrap">${escapeHtml(ascii)}</pre></div>`,
    });
  }
}

export class DiscordNotifier {
  constructor({ webhookUrl }, { fetch: fetchImplementation = globalThis.fetch, random = Math.random } = {}) {
    this.webhookUrl = webhookUrl;
    this.fetch = fetchImplementation;
    this.random = random;
    this.enabled = Boolean(webhookUrl && this.fetch);
  }

  async send({ sprint, localDate, users, applicationUrl }) {
    if (!this.enabled) throw new Error('Discord is not configured.');
    const names = users.map((user) => user.name || user.email).join(', ');
    const line = randomItem(STANDUP_LINES, this.random);
    const ascii = randomItem(ASCII_FRIENDS, this.random);
    const content = [
      `Standup reminder — **${sprint.name}** — ${localDate}`,
      `Still missing: ${names}`,
      `Done · To do · Problem — submit here: ${applicationUrl}`,
      line,
      `\`\`\`\n${ascii}\n\`\`\``,
    ].join('\n\n').slice(0, 1_950);
    const response = await this.fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    });
    if (!response.ok) throw new Error(`Discord webhook request failed (${response.status}).`);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}
