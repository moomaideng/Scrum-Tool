const BASE = '/standup';
const state = { me: null, dashboard: null, admin: null, adminAuthenticated: false, config: null };
const elements = Object.fromEntries([...document.querySelectorAll('[id]')].map((element) => [element.id, element]));

function notice(element, message = '') {
  element.textContent = message;
  element.hidden = !message;
}

async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message ?? 'Something went wrong. Please try again.');
    error.status = response.status;
    throw error;
  }
  return body;
}

function formatDate(value) {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${value}T00:00:00Z`));
}

function bangkokDate() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function initialize() {
  state.config = await api('/api/config');
  const errorCode = new URLSearchParams(location.search).get('auth_error');
  if (errorCode) {
    const messages = {
      csrf: 'Google sign-in could not be validated. Please try again.',
      configuration: 'Google sign-in has not been configured yet.',
      not_allowed: 'Your email has not been invited. Ask the administrator to add it first.',
      google: 'Google sign-in failed. Please try again.',
    };
    notice(elements['login-error'], messages[errorCode] ?? 'Sign-in failed.');
    history.replaceState(null, '', `${BASE}/`);
  }
  try {
    state.me = await api('/api/me');
    await showApplication();
  } catch (error) {
    if (error.status !== 401) notice(elements['login-error'], error.message);
    await showLogin();
  }
}

async function showLogin() {
  elements['app-screen'].hidden = true;
  elements['login-screen'].hidden = false;
  if (!state.config.googleClientId) {
    notice(elements['login-error'], 'Google sign-in is not configured. Ask the administrator to finish setup.');
    return;
  }
  for (let attempt = 0; attempt < 50 && !window.google?.accounts?.id; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!window.google?.accounts?.id) {
    notice(elements['login-error'], 'Could not load Google sign-in. Check your connection and reload.');
    return;
  }
  window.google.accounts.id.initialize({
    client_id: state.config.googleClientId,
    ux_mode: 'redirect',
    login_uri: state.config.googleLoginUri,
  });
  window.google.accounts.id.renderButton(elements['google-signin'], {
    theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with', width: 300,
  });
}

async function showApplication() {
  elements['login-screen'].hidden = true;
  elements['app-screen'].hidden = false;
  elements['account-name'].textContent = state.me.user.name;
  elements['admin-open'].hidden = !state.me.canAdmin;
  if (state.me.user.avatarUrl) {
    elements['account-avatar'].src = state.me.user.avatarUrl;
    elements['account-avatar'].hidden = false;
  }
  await loadDashboard();
}

async function loadDashboard(sprintId, date) {
  notice(elements['app-error']);
  const params = new URLSearchParams();
  if (sprintId) params.set('sprintId', sprintId);
  if (date) params.set('date', date);
  try {
    state.dashboard = await api(`/api/dashboard${params.size ? `?${params}` : ''}`);
    renderDashboard();
  } catch (error) {
    notice(elements['app-error'], error.message);
  }
}

function renderDashboard() {
  const dashboard = state.dashboard;
  elements['date-select'].max = dashboard.currentDate;
  elements['date-select'].value = dashboard.date;
  elements['date-heading'].textContent = formatDate(dashboard.date);
  elements['sprint-select'].replaceChildren();
  for (const sprint of dashboard.sprints) {
    const option = document.createElement('option');
    option.value = sprint.id;
    option.textContent = `${sprint.name}${sprint.id === dashboard.activeSprintId ? ' · active' : ''}`;
    option.selected = sprint.id === dashboard.sprint?.id;
    elements['sprint-select'].append(option);
  }
  elements['sprint-select'].disabled = dashboard.sprints.length === 0;
  elements['sprint-title'].textContent = dashboard.sprint?.name ?? 'No active sprint';
  elements['empty-sprint'].hidden = Boolean(dashboard.sprint);
  elements.dashboard.hidden = !dashboard.sprint;
  if (!dashboard.sprint) return;

  const own = dashboard.ownSubmission;
  elements['standup-form'].hidden = !dashboard.canEdit;
  elements['readonly-own'].hidden = dashboard.canEdit;
  if (dashboard.canEdit) {
    elements.done.value = own?.done ?? '';
    elements.todo.value = own?.todo ?? '';
    elements.problem.value = own?.problem ?? '';
    elements['entry-state'].textContent = own ? 'Submitted' : 'Not submitted';
    elements['entry-state'].className = `status-pill ${own ? 'complete' : 'waiting'}`;
    elements['save-standup'].textContent = own ? 'Update today’s standup' : 'Save today’s standup';
    elements['edit-note'].textContent = own ? 'You can edit this until Bangkok midnight.' : 'All three answers are required.';
  } else {
    elements['entry-state'].textContent = own ? 'Submitted' : 'No entry';
    elements['entry-state'].className = `status-pill ${own ? 'complete' : 'waiting'}`;
    renderReadOnlyOwn(own);
  }
  renderTeam();
}

function renderReadOnlyOwn(submission) {
  elements['readonly-own'].replaceChildren();
  if (!submission) {
    const paragraph = document.createElement('p');
    paragraph.className = 'empty-copy';
    paragraph.textContent = 'You did not submit an entry for this date.';
    elements['readonly-own'].append(paragraph);
    return;
  }
  for (const [label, value] of [['Done', submission.done], ['To do', submission.todo], ['Problem', submission.problem]]) {
    const block = document.createElement('div');
    const title = document.createElement('strong');
    const content = document.createElement('p');
    title.textContent = label;
    content.textContent = value;
    block.append(title, content);
    elements['readonly-own'].append(block);
  }
}

function renderTeam() {
  const dashboard = state.dashboard;
  const submissions = new Map(dashboard.submissions.map((submission) => [submission.userId, submission]));
  elements['team-list'].replaceChildren();
  elements['completion-count'].textContent = `${submissions.size} of ${dashboard.members.length} submitted`;
  elements['team-title'].textContent = dashboard.date === dashboard.currentDate ? 'Today’s standups' : `Standups for ${formatDate(dashboard.date)}`;
  for (const member of dashboard.members) {
    const submission = submissions.get(member.id);
    const fragment = elements['member-template'].content.cloneNode(true);
    const card = fragment.querySelector('.member-card');
    const image = card.querySelector('img');
    const fallback = card.querySelector('.avatar-fallback');
    if (member.avatarUrl) {
      image.src = member.avatarUrl;
      image.alt = `${member.name} profile`;
      image.hidden = false;
      fallback.hidden = true;
    } else {
      fallback.textContent = member.name.slice(0, 1).toLocaleUpperCase();
    }
    card.querySelector('h3').textContent = member.name;
    card.querySelector('.member-identity p').textContent = member.email;
    const status = card.querySelector('.member-status');
    status.textContent = submission ? 'Submitted' : 'Waiting';
    status.classList.add(submission ? 'complete' : 'waiting');
    const answers = card.querySelector('.member-answers');
    if (submission) {
      for (const [label, value] of [['Done', submission.done], ['To do', submission.todo], ['Problem', submission.problem]]) {
        const wrapper = document.createElement('div');
        const heading = document.createElement('strong');
        const content = document.createElement('p');
        heading.textContent = label;
        content.textContent = value;
        wrapper.append(heading, content);
        answers.append(wrapper);
      }
    } else {
      const waiting = document.createElement('p');
      waiting.className = 'empty-copy';
      waiting.textContent = 'No standup submitted for this date.';
      answers.append(waiting);
    }
    elements['team-list'].append(fragment);
  }
}

async function saveStandup(event) {
  event.preventDefault();
  notice(elements['app-error']);
  notice(elements['app-success']);
  const data = new FormData(event.currentTarget);
  const button = elements['save-standup'];
  button.disabled = true;
  try {
    await api('/api/submissions/today', {
      method: 'PUT',
      body: JSON.stringify({ done: data.get('done'), todo: data.get('todo'), problem: data.get('problem') }),
    });
    notice(elements['app-success'], 'Your standup has been saved and queued for Google Sheets.');
    await loadDashboard();
  } catch (error) {
    notice(elements['app-error'], error.message);
  } finally {
    button.disabled = false;
  }
}

async function openAdmin() {
  notice(elements['admin-error']);
  notice(elements['admin-success']);
  elements['admin-dialog'].showModal();
  if (state.adminAuthenticated) await loadAdmin();
  else {
    elements['admin-login'].hidden = false;
    elements['admin-controls'].hidden = true;
    elements['admin-password'].focus();
  }
}

async function unlockAdmin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  notice(elements['admin-error']);
  try {
    const data = new FormData(form);
    await api('/api/admin/session', { method: 'POST', body: JSON.stringify({ password: data.get('password') }) });
    state.adminAuthenticated = true;
    form.reset();
    await loadAdmin();
  } catch (error) {
    notice(elements['admin-error'], error.message);
  }
}

async function loadAdmin() {
  try {
    state.admin = await api('/api/admin');
    elements['admin-login'].hidden = true;
    elements['admin-controls'].hidden = false;
    renderAdmin();
  } catch (error) {
    if (error.status === 403) state.adminAuthenticated = false;
    notice(elements['admin-error'], error.message);
  }
}

function renderAdmin() {
  elements['allowed-count'].textContent = `${state.admin.allowedEmails.length} allowed`;
  elements['allowed-emails'].replaceChildren();
  for (const entry of state.admin.allowedEmails) {
    const row = document.createElement('div');
    row.className = 'admin-user';
    const identity = document.createElement('span');
    const email = document.createElement('strong');
    const status = document.createElement('small');
    const remove = document.createElement('button');
    email.textContent = entry.email;
    status.textContent = entry.userId ? `Registered as ${entry.userName}` : 'Waiting for first sign-in';
    identity.append(email, status);
    remove.type = 'button';
    remove.className = 'quiet-button danger-button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => removeAllowedEmail(entry.email, remove));
    row.append(identity, remove);
    elements['allowed-emails'].append(row);
  }
  elements['user-count'].textContent = `${state.admin.users.length} people`;
  elements['admin-users'].replaceChildren();
  for (const user of state.admin.users) {
    const label = document.createElement('label');
    label.className = 'admin-user';
    const identity = document.createElement('span');
    const name = document.createElement('strong');
    const email = document.createElement('small');
    name.textContent = user.name;
    email.textContent = user.email;
    identity.append(name, email);
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = user.remindersEnabled;
    toggle.setAttribute('aria-label', `Send reminders to ${user.name}`);
    toggle.addEventListener('change', () => updateUserReminder(user.id, toggle));
    label.append(identity, toggle);
    elements['admin-users'].append(label);
  }
  const sheetLabel = state.admin.sheet.enabled ? 'Google Sheets connected' : 'Google Sheets not configured';
  const emailLabel = state.admin.email.enabled ? 'email connected' : 'email not configured';
  elements['integration-summary'].textContent = `${sheetLabel}; ${emailLabel}.`;
  elements['reminder-time'].value = state.admin.email.time;
  elements['send-reminders'].disabled = !state.admin.email.enabled;
  elements['retry-sheets'].disabled = !state.admin.sheet.enabled;
  elements['integration-jobs'].replaceChildren();
  if (!state.admin.sheet.jobs.length) {
    elements['integration-jobs'].textContent = 'No Sheet sync jobs yet.';
  } else {
    for (const job of state.admin.sheet.jobs) {
      const line = document.createElement('p');
      line.textContent = `${job.sprintName}: ${job.status}${job.lastError ? ` — ${job.lastError}` : ''}`;
      elements['integration-jobs'].append(line);
    }
  }
  const failedEmails = state.admin.email.deliveries.filter((delivery) => delivery.lastError && !delivery.sentAt);
  for (const delivery of failedEmails.slice(0, 5)) {
    const line = document.createElement('p');
    line.textContent = `Email to ${delivery.email} on ${delivery.localDate}: ${delivery.lastError}`;
    elements['integration-jobs'].append(line);
  }
}

async function addAllowedEmail(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  notice(elements['admin-error']);
  notice(elements['admin-success']);
  try {
    await api('/api/admin/allowed-emails', { method: 'POST', body: JSON.stringify({ email: data.get('email') }) });
    form.reset();
    notice(elements['admin-success'], 'Email added. That person can now sign in with Google.');
    await loadAdmin();
  } catch (error) {
    notice(elements['admin-error'], error.message);
  }
}

async function removeAllowedEmail(email, button) {
  if (!window.confirm(`Remove ${email} from the allowed emails? Their active sessions will be signed out.`)) return;
  button.disabled = true;
  notice(elements['admin-error']);
  try {
    await api(`/api/admin/allowed-emails/${encodeURIComponent(email)}`, { method: 'DELETE', body: '{}' });
    await loadAdmin();
  } catch (error) {
    notice(elements['admin-error'], error.message);
    button.disabled = false;
  }
}

async function saveReminderTime(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  notice(elements['admin-error']);
  try {
    const result = await api('/api/admin/reminders', { method: 'PATCH', body: JSON.stringify({ time: data.get('time') }) });
    notice(elements['admin-success'], `Daily reminder time saved as ${result.time} Asia/Bangkok.`);
    await loadAdmin();
  } catch (error) {
    notice(elements['admin-error'], error.message);
  }
}

async function sendRemindersNow() {
  const button = elements['send-reminders'];
  button.disabled = true;
  notice(elements['admin-error']);
  notice(elements['admin-success']);
  try {
    const result = await api('/api/admin/reminders/send', { method: 'POST', body: '{}' });
    notice(elements['admin-success'], `Reminder run finished: ${result.sent} sent, ${result.failed} failed.`);
    await loadAdmin();
  } catch (error) {
    notice(elements['admin-error'], error.message);
  } finally {
    button.disabled = false;
  }
}

async function updateUserReminder(userId, toggle) {
  toggle.disabled = true;
  try {
    await api(`/api/admin/users/${encodeURIComponent(userId)}`, {
      method: 'PATCH', body: JSON.stringify({ remindersEnabled: toggle.checked }),
    });
    await loadAdmin();
  } catch (error) {
    toggle.checked = !toggle.checked;
    notice(elements['admin-error'], error.message);
  } finally {
    toggle.disabled = false;
  }
}

async function createSprint(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const name = String(data.get('name')).trim();
  if (state.dashboard?.sprint && !window.confirm(`Close ${state.dashboard.sprint.name} and start ${name}? Existing entries will be kept.`)) return;
  try {
    await api('/api/admin/sprints', { method: 'POST', body: JSON.stringify({ name }) });
    form.reset();
    await Promise.all([loadAdmin(), loadDashboard()]);
  } catch (error) {
    notice(elements['admin-error'], error.message);
  }
}

elements['standup-form'].addEventListener('submit', saveStandup);
elements['sprint-select'].addEventListener('change', () => loadDashboard(elements['sprint-select'].value, elements['date-select'].value));
elements['date-select'].addEventListener('change', () => loadDashboard(elements['sprint-select'].value, elements['date-select'].value));
elements.logout.addEventListener('click', async () => { await api('/api/logout', { method: 'POST', body: '{}' }); location.assign(`${BASE}/`); });
elements['admin-open'].addEventListener('click', openAdmin);
elements['admin-open-login'].addEventListener('click', openAdmin);
elements['admin-close'].addEventListener('click', () => elements['admin-dialog'].close());
elements['admin-login'].addEventListener('submit', unlockAdmin);
elements['sprint-form'].addEventListener('submit', createSprint);
elements['allowed-email-form'].addEventListener('submit', addAllowedEmail);
elements['reminder-form'].addEventListener('submit', saveReminderTime);
elements['send-reminders'].addEventListener('click', sendRemindersNow);
elements['retry-sheets'].addEventListener('click', async () => {
  try {
    await api('/api/admin/sheets/retry', { method: 'POST', body: '{}' });
    await loadAdmin();
  } catch (error) { notice(elements['admin-error'], error.message); }
});

initialize().catch((error) => {
  elements['login-screen'].hidden = false;
  notice(elements['login-error'], error.message);
});

setInterval(() => {
  const dashboard = state.dashboard;
  const viewingLiveSprint = dashboard?.sprint?.id === dashboard?.activeSprintId && dashboard?.date === dashboard?.currentDate;
  if (state.me && viewingLiveSprint && bangkokDate() !== dashboard.currentDate) void loadDashboard();
}, 30_000);
