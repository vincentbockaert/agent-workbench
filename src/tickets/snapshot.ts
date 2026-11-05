import * as fs from 'fs';
import * as path from 'path';
import type { EffectiveSource } from './expand';
import { fetchTickets, Ticket, TicketSourceConfig } from './source';

// What the tree renders: the last successful fetch, plus the last error if the latest refresh failed.
export interface Snapshot {
  source: string;
  fetchedAt?: string; // ISO time of the last successful fetch
  tickets: Ticket[];
  error?: { message: string; at: string };
}

function snapshotFile(dir: string, source: string): string {
  return path.join(dir, `${encodeURIComponent(source)}.json`);
}

// A missing or corrupt file means "no snapshot yet"; the next refresh rewrites it.
export function readSnapshot(dir: string, source: string): Snapshot | undefined {
  try {
    return JSON.parse(fs.readFileSync(snapshotFile(dir, source), 'utf8')) as Snapshot;
  } catch {
    return undefined;
  }
}

function writeSnapshot(dir: string, snap: Snapshot): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = snapshotFile(dir, snap.source);
  // Write then rename, so a crash mid-write never leaves a half-written snapshot.
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(snap, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

// On failure the previous tickets stay visible (offline-first); only the error is recorded.
export async function refreshSource(cfg: TicketSourceConfig, cwd: string, dir: string, now: Date): Promise<Snapshot> {
  let snap: Snapshot;
  try {
    const tickets = await fetchTickets(cfg, cwd);
    snap = { source: cfg.name, fetchedAt: now.toISOString(), tickets };
  } catch (e) {
    const prev = readSnapshot(dir, cfg.name);
    snap = {
      source: cfg.name,
      fetchedAt: prev?.fetchedAt,
      tickets: prev?.tickets ?? [],
      error: { message: (e as Error).message, at: now.toISOString() },
    };
  }
  writeSnapshot(dir, snap);
  return snap;
}

// Refreshes every effective source in its own folder. One failing source or repo never affects the others
// (refreshSource records the error in that source's snapshot instead of throwing).
export function refreshAll(sources: EffectiveSource[], dir: string, now: Date): Promise<Snapshot[]> {
  return Promise.all(sources.map((s) => refreshSource(s.cfg, s.cwd, dir, now)));
}

export function describeAge(fetchedAt: string | undefined, now: Date): string {
  if (!fetchedAt) {
    return 'never fetched';
  }
  const minutes = Math.floor((now.getTime() - new Date(fetchedAt).getTime()) / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  if (minutes < 24 * 60) {
    return `${Math.floor(minutes / 60)}h ago`;
  }
  return `${Math.floor(minutes / (24 * 60))}d ago`;
}
