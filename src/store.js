import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const COLUMNS = new Set(['continue', 'cancel', 'add']);

function blankState() {
  return { participants: [], sessions: [], cards: [] };
}

export class RetrospectiveStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'retrospective.json');
    this.dataDir = dataDir;
    this.state = null;
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      this.state = {
        participants: Array.isArray(saved.participants) ? saved.participants : [],
        sessions: Array.isArray(saved.sessions) ? saved.sessions : [],
        cards: Array.isArray(saved.cards) ? saved.cards : [],
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.state = blankState();
      await this.persist();
    }
  }

  async persist() {
    const tempFile = `${this.file}.tmp`;
    this.writeQueue = this.writeQueue.then(async () => {
      await writeFile(tempFile, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
      await rename(tempFile, this.file);
    });
    return this.writeQueue;
  }

  board() {
    return {
      cards: [...this.state.cards].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      participants: [...this.state.participants].sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  async join(name) {
    const normalisedName = name.trim().replace(/\s+/g, ' ');
    let participant = this.state.participants.find(
      (item) => item.name.toLocaleLowerCase() === normalisedName.toLocaleLowerCase(),
    );
    if (!participant) {
      participant = { id: randomUUID(), name: normalisedName, createdAt: new Date().toISOString() };
      this.state.participants.push(participant);
    }

    const token = randomUUID();
    this.state.sessions = this.state.sessions.filter((session) => session.participantId !== participant.id);
    this.state.sessions.push({ token, participantId: participant.id, createdAt: new Date().toISOString() });
    await this.persist();
    return { participant, token };
  }

  participantForToken(token) {
    const session = this.state.sessions.find((item) => item.token === token);
    if (!session) return null;
    return this.state.participants.find((item) => item.id === session.participantId) ?? null;
  }

  async addCard(participant, column, content) {
    const card = {
      id: randomUUID(),
      column,
      content: content.trim(),
      authorId: participant.id,
      authorName: participant.name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.state.cards.push(card);
    await this.persist();
    return card;
  }

  async updateCard(id, participant, content) {
    const card = this.state.cards.find((item) => item.id === id);
    if (!card) return { kind: 'missing' };
    if (card.authorId !== participant.id) return { kind: 'forbidden' };
    card.content = content.trim();
    card.updatedAt = new Date().toISOString();
    await this.persist();
    return { kind: 'ok', card };
  }

  async deleteCard(id, participant) {
    const index = this.state.cards.findIndex((item) => item.id === id);
    if (index === -1) return 'missing';
    if (this.state.cards[index].authorId !== participant.id) return 'forbidden';
    this.state.cards.splice(index, 1);
    await this.persist();
    return 'ok';
  }

  async reset() {
    this.state = blankState();
    await this.persist();
  }
}

export function isValidColumn(column) {
  return COLUMNS.has(column);
}
