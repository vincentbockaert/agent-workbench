import * as fs from 'fs';
import * as path from 'path';
import { Session } from './model';

// Sessions persisted as one JSON file in the extension's global storage.
export class SessionStore {
  // Set when the file was unreadable at load time; the bad file is kept next to it as a backup.
  readonly warning?: string;
  private sessions: Session[] = [];

  constructor(private readonly file: string) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return; // no file yet
    }
    try {
      this.sessions = JSON.parse(text) as Session[];
      if (!Array.isArray(this.sessions)) {
        throw new Error('not an array');
      }
    } catch (e) {
      this.sessions = [];
      const backup = `${file}.corrupt-${Date.now()}`;
      fs.renameSync(file, backup);
      this.warning = `${path.basename(file)} was unreadable (${(e as Error).message}); moved to ${backup}`;
    }
  }

  list(): Session[] {
    return [...this.sessions];
  }

  add(session: Session): void {
    if (this.sessions.some((s) => s.id === session.id)) {
      throw new Error(`session "${session.id}" already exists`);
    }
    this.sessions.push(session);
    this.save();
  }

  update(id: string, patch: Partial<Omit<Session, 'id'>>): Session {
    const i = this.sessions.findIndex((s) => s.id === id);
    if (i < 0) {
      throw new Error(`no session "${id}"`);
    }
    this.sessions[i] = { ...this.sessions[i], ...patch };
    this.save();
    return this.sessions[i];
  }

  remove(id: string): void {
    this.sessions = this.sessions.filter((s) => s.id !== id);
    this.save();
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.sessions, null, 2));
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
}
