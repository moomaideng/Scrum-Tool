const columns = [
  { id: 'continue', title: 'What went well?', subtitle: 'Continue', icon: '✓' },
  { id: 'cancel', title: "What didn't go well?", subtitle: 'Cancel', icon: '×' },
  { id: 'add', title: 'What can we improve next sprint?', subtitle: 'Add', icon: '+' },
];

const state = { token: localStorage.getItem('retro-token'), participant: null, board: null };
const joinScreen = document.querySelector('#join-screen');
const boardScreen = document.querySelector('#board-screen');
const joinError = document.querySelector('#join-error');
const boardError = document.querySelector('#board-error');
const columnsElement = document.querySelector('#columns');

function showError(element, message = '') {
  element.textContent = message;
  element.hidden = !message;
}

async function api(url, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers ?? {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(url, { ...options, headers });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message ?? 'Something went wrong. Please try again.');
  return body;
}

function render() {
  columnsElement.replaceChildren();
  const columnTemplate = document.querySelector('#column-template');
  const cardTemplate = document.querySelector('#card-template');
  for (const definition of columns) {
    const fragment = columnTemplate.content.cloneNode(true);
    const section = fragment.querySelector('.column');
    section.dataset.column = definition.id;
    section.querySelector('.column-icon').textContent = definition.icon;
    section.querySelector('h2').textContent = definition.subtitle;
    section.querySelector('.column-heading p').textContent = definition.title;
    section.querySelector('.card-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const textarea = event.currentTarget.querySelector('textarea');
      await addCard(definition.id, textarea);
    });
    const cardContainer = section.querySelector('.cards');
    const cards = state.board.cards.filter((card) => card.column === definition.id);
    for (const card of cards) {
      const cardFragment = cardTemplate.content.cloneNode(true);
      const cardElement = cardFragment.querySelector('.card');
      cardElement.querySelector('.card-content').textContent = card.content;
      cardElement.querySelector('.card-author').textContent = card.authorName;
      if (card.authorId === state.participant.id) {
        const actions = cardElement.querySelector('.card-actions');
        const editButton = document.createElement('button');
        editButton.type = 'button'; editButton.className = 'card-button'; editButton.textContent = 'Edit';
        editButton.addEventListener('click', () => editCard(card));
        const deleteButton = document.createElement('button');
        deleteButton.type = 'button'; deleteButton.className = 'card-button danger'; deleteButton.textContent = 'Delete';
        deleteButton.addEventListener('click', () => deleteCard(card));
        actions.append(editButton, deleteButton);
      }
      cardContainer.append(cardFragment);
    }
    columnsElement.append(fragment);
  }
}

async function refresh() {
  try {
    state.board = await api('/api/board');
    state.participant = state.board.currentParticipant;
    document.querySelector('#member-name').textContent = `Joined as ${state.participant.name}`;
    joinScreen.hidden = true;
    boardScreen.hidden = false;
    render();
  } catch (error) {
    localStorage.removeItem('retro-token');
    state.token = null;
    boardScreen.hidden = true;
    joinScreen.hidden = false;
  }
}

async function addCard(column, textarea) {
  showError(boardError);
  try {
    await api('/api/cards', { method: 'POST', body: JSON.stringify({ column, content: textarea.value }) });
    textarea.value = '';
    await refresh();
  } catch (error) { showError(boardError, error.message); }
}

async function editCard(card) {
  const content = window.prompt('Edit your note', card.content);
  if (content === null || content.trim() === card.content) return;
  try {
    await api(`/api/cards/${card.id}`, { method: 'PATCH', body: JSON.stringify({ content }) });
    await refresh();
  } catch (error) { showError(boardError, error.message); }
}

async function deleteCard(card) {
  if (!window.confirm('Delete this note?')) return;
  try {
    await api(`/api/cards/${card.id}`, { method: 'DELETE' });
    await refresh();
  } catch (error) { showError(boardError, error.message); }
}

document.querySelector('#join-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  showError(joinError);
  const form = new FormData(event.currentTarget);
  try {
    const session = await api('/api/session', {
      method: 'POST',
      body: JSON.stringify({ name: form.get('name') }),
    });
    state.token = session.token;
    state.participant = session.participant;
    localStorage.setItem('retro-token', state.token);
    await refresh();
  } catch (error) { showError(joinError, error.message); }
});

document.querySelector('#change-member').addEventListener('click', () => {
  localStorage.removeItem('retro-token'); state.token = null; state.participant = null;
  boardScreen.hidden = true; joinScreen.hidden = false;
  document.querySelector('#name').focus();
});

document.querySelector('#reset-board').addEventListener('click', async () => {
  const confirmed = window.confirm('Reset the whole board? This permanently deletes every name and note.');
  if (!confirmed) return;
  try {
    await api('/api/board', { method: 'DELETE' });
    localStorage.removeItem('retro-token'); state.token = null; state.participant = null; state.board = null;
    boardScreen.hidden = true; joinScreen.hidden = false;
    document.querySelector('#name').focus();
  } catch (error) { showError(boardError, error.message); }
});

if (state.token) refresh();
setInterval(() => { if (state.token) refresh(); }, 10000);
