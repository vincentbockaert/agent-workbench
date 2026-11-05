import * as fs from 'fs';

// A safety net for the file watcher. VS Code's watcher can silently fail on big workspaces (ENOSPC on a
// folder with dozens of repos), which would lose every status change: no "needs input", no agent or prompt
// time. This polls cheaply instead: one async stat per session, no read, and reports only real changes.
//
// Cost: sessions that are live are stat'ed every tick; sessions that are exited or have no status file
// ("cold") only every `coldEvery`-th tick, unless heated (an agent was just started there). Ticks never overlap.
interface Entry {
  file: string;
  sig: string;
  heatUntil: number;
}

// Inode + mtime + size: wb.js writes through a rename, so every update is a new inode.
function signatureOf(stat: fs.Stats): string {
  return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
}

function signatureSync(file: string): string {
  try {
    return signatureOf(fs.statSync(file));
  } catch {
    return 'missing';
  }
}

async function signature(file: string): Promise<string> {
  try {
    return signatureOf(await fs.promises.stat(file));
  } catch {
    return 'missing';
  }
}

export class StatusPoller {
  private readonly entries = new Map<string, Entry>();
  private ticks = 0;
  private running = false;

  constructor(
    private readonly onChange: (id: string) => void,
    private readonly cold: (id: string) => boolean,
    private readonly coldEvery = 5,
    private readonly now: () => number = Date.now,
  ) {}

  // Starts watching a file; its current state is the baseline, so nothing is reported for what is already there.
  add(id: string, file: string): void {
    if (!this.entries.has(id)) {
      this.entries.set(id, { file, sig: signatureSync(file), heatUntil: 0 });
    }
  }

  remove(id: string): void {
    this.entries.delete(id);
  }

  // The caller just handled the file's current state (e.g. the file watcher fired), so do not report it again.
  // Call this before reading the file: a change after this point is still reported on the next tick.
  note(id: string): void {
    const e = this.entries.get(id);
    if (e) {
      e.sig = signatureSync(e.file);
    }
  }

  // Check this session on every tick for a while even if it looks cold (an agent was just started in it).
  heat(id: string, ms: number): void {
    const e = this.entries.get(id);
    if (e) {
      e.heatUntil = this.now() + ms;
    }
  }

  async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      this.ticks++;
      const now = this.now();
      const due = [...this.entries].filter(([id, e]) => now < e.heatUntil || !this.cold(id) || this.ticks % this.coldEvery === 0);
      for (const [id, e] of due) {
        const sig = await signature(e.file);
        // Removed or re-added while we were waiting: that entry's story is over.
        if (this.entries.get(id) === e && sig !== e.sig) {
          e.sig = sig;
          this.onChange(id);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
