import * as fs from 'fs';
import * as path from 'path';

// The workbench's own status per ticket: the same four steps for every tracker, kept locally.
// The tracker's status stays read-only (from the last import) and is shown next to it, never changed.
export type WorkStatus = 'todo' | 'doing' | 'review' | 'done';
export const WORK_STATUSES: WorkStatus[] = ['todo', 'doing', 'review', 'done'];
export const WORK_LABELS: Record<WorkStatus, string> = { todo: 'To do', doing: 'Doing', review: 'Review', done: 'Done' };

export type WorkEvent = 'session-started' | 'pr-created';

// Automatic moves, only where the signal is unambiguous; undefined = leave it.
export function statusAfter(current: WorkStatus, event: WorkEvent): WorkStatus | undefined {
  if (event === 'session-started') {
    return current === 'doing' ? undefined : 'doing'; // new work on any ticket means you are doing it
  }
  return current === 'todo' || current === 'doing' ? 'review' : undefined; // a PR never reopens a Done ticket
}

// Ticket key → status, in one JSON file. A missing ticket is "todo".
export class WorkflowStore {
  readonly warning?: string;
  private statuses: Record<string, WorkStatus> = {};

  constructor(private readonly file: string) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return; // no file yet
    }
    try {
      const raw = JSON.parse(text) as Record<string, unknown>;
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('not an object');
      }
      for (const [key, value] of Object.entries(raw)) {
        if (WORK_STATUSES.includes(value as WorkStatus)) {
          this.statuses[key] = value as WorkStatus;
        }
      }
    } catch (e) {
      const backup = `${file}.corrupt-${Date.now()}`;
      fs.renameSync(file, backup);
      this.warning = `${path.basename(file)} was unreadable (${(e as Error).message}); moved to ${backup}`;
    }
  }

  get(key: string): WorkStatus {
    return this.statuses[key] ?? 'todo';
  }

  set(key: string, status: WorkStatus): void {
    this.statuses[key] = status;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.statuses, null, 2));
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
}
