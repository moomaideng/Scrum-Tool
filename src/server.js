import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RetrospectiveStore, isValidColumn } from './store.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.join(currentDirectory, '..', 'public');
const dataDirectory = process.env.DATA_DIR ?? path.join(currentDirectory, '..', 'data');
const port = Number(process.env.PORT ?? 3000);

const store = new RetrospectiveStore(dataDirectory);
await store.initialize();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(express.static(publicDirectory));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function session(req, res, next) {
  const token = req.get('authorization')?.replace(/^Bearer\s+/i, '');
  const participant = token ? store.participantForToken(token) : null;
  if (!participant) return res.status(401).json({ message: 'Your session has expired. Join the retrospective again.' });
  req.participant = participant;
  next();
}

app.post('/api/session', async (req, res) => {
  const name = text(req.body?.name);
  if (name.length < 2 || name.length > 50) {
    return res.status(400).json({ message: 'Use a name between 2 and 50 characters.' });
  }
  const joined = await store.join(name);
  res.status(201).json(joined);
});

app.get('/api/board', session, (req, res) => {
  res.json({ ...store.board(), currentParticipant: req.participant });
});

app.post('/api/cards', session, async (req, res) => {
  const column = text(req.body?.column);
  const content = text(req.body?.content);
  if (!isValidColumn(column)) return res.status(400).json({ message: 'Choose a valid retrospective column.' });
  if (content.length < 2 || content.length > 500) {
    return res.status(400).json({ message: 'Each note must be between 2 and 500 characters.' });
  }
  res.status(201).json(await store.addCard(req.participant, column, content));
});

app.patch('/api/cards/:id', session, async (req, res) => {
  const content = text(req.body?.content);
  if (content.length < 2 || content.length > 500) {
    return res.status(400).json({ message: 'Each note must be between 2 and 500 characters.' });
  }
  const result = await store.updateCard(req.params.id, req.participant, content);
  if (result.kind === 'missing') return res.status(404).json({ message: 'This note no longer exists.' });
  if (result.kind === 'forbidden') return res.status(403).json({ message: 'You can only edit your own notes.' });
  res.json(result.card);
});

app.delete('/api/cards/:id', session, async (req, res) => {
  const result = await store.deleteCard(req.params.id, req.participant);
  if (result === 'missing') return res.status(404).json({ message: 'This note no longer exists.' });
  if (result === 'forbidden') return res.status(403).json({ message: 'You can only delete your own notes.' });
  res.status(204).end();
});

app.delete('/api/board', session, async (req, res) => {
  await store.reset();
  res.status(204).end();
});

app.get('/{*splat}', (req, res) => res.sendFile(path.join(publicDirectory, 'index.html')));

app.listen(port, () => {
  console.log(`Scrum retrospective tool is listening on port ${port}`);
});
