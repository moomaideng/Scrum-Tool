import assert from 'node:assert/strict';
import test from 'node:test';
import { ReminderMailer } from '../src/integrations.js';

test('reminder email includes a random line and ASCII art in text and HTML', async () => {
  const messages = [];
  const mailer = new ReminderMailer({
    host: 'smtp.example.com', port: 465, secure: true,
    user: 'sender@example.com', password: 'secret', from: 'sender@example.com',
  }, {
    random: () => 0,
    transport: { async sendMail(message) { messages.push(message); } },
  });

  await mailer.send({
    user: { name: 'A&B', email: 'friend@example.com' },
    sprint: { name: 'Sprint 1' },
    localDate: '2026-09-13',
    applicationUrl: 'https://example.com/standup/',
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].to, 'friend@example.com');
  assert.match(messages[0].text, /Tiny updates prevent giant surprises\./);
  assert.match(messages[0].text, /\( o\.o \)/);
  assert.match(messages[0].html, /Tiny updates prevent giant surprises\./);
  assert.match(messages[0].html, /A&amp;B/);
  assert.match(messages[0].html, /<pre/);
});
