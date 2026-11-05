import * as fs from 'fs';
import * as path from 'path';
import { fetchRepoPullRequests, FetchResult, RepoRef } from './fetch';
import { prsForTicket, PullRequest, sortPullRequests } from './model';

// What the ticket tab renders: the last successful fetch per repo, plus the errors of the latest refresh.
// Like ticket snapshots it is offline-first: a failing repo keeps its previous PRs.
export interface PrSnapshot {
  ticket: string; // "<source>:<id>"
  fetchedAt?: string; // ISO time of the last refresh in which at least one repo answered
  prs: PullRequest[];
  errors: { repo: string; message: string }[];
}

export interface PrTarget {
  repo: RepoRef;
  branches: string[]; // the ticket's branches in this repo
}

const CONCURRENCY = 4;

function file(dir: string, ticket: string): string {
  return path.join(dir, `${encodeURIComponent(ticket)}.json`);
}

// A missing or corrupt file means "no snapshot yet"; the next refresh rewrites it.
export function readPrSnapshot(dir: string, ticket: string): PrSnapshot | undefined {
  try {
    const snap = JSON.parse(fs.readFileSync(file(dir, ticket), 'utf8')) as PrSnapshot;
    return Array.isArray(snap.prs) && Array.isArray(snap.errors) ? snap : undefined;
  } catch {
    return undefined;
  }
}

export function writePrSnapshot(dir: string, snap: PrSnapshot): void {
  fs.mkdirSync(dir, { recursive: true });
  const target = file(dir, snap.ticket);
  // Write then rename, so a crash mid-write never leaves a half-written snapshot.
  fs.writeFileSync(`${target}.tmp`, JSON.stringify(snap, null, 2));
  fs.renameSync(`${target}.tmp`, target);
}

export function isStale(snap: PrSnapshot | undefined, now: Date, maxAgeMs: number): boolean {
  return !snap?.fetchedAt || now.getTime() - Date.parse(snap.fetchedAt) > maxAgeMs;
}

// Looks at the repos that carry the ticket's work, keeps the PRs that belong to the ticket, and stores the result.
export async function refreshTicketPrs(
  key: string,
  ticket: { id: string },
  targets: PrTarget[],
  dir: string,
  now: Date,
  opts: { fetch?: (repo: RepoRef) => Promise<FetchResult> } = {},
): Promise<PrSnapshot> {
  const fetch = opts.fetch ?? ((repo: RepoRef) => fetchRepoPullRequests(repo));
  const previous = readPrSnapshot(dir, key);
  const results: FetchResult[] = new Array(targets.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < targets.length) {
      const i = next++;
      results[i] = await fetch(targets[i].repo);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));

  const prs: PullRequest[] = [];
  const errors: PrSnapshot['errors'] = [];
  let answered = targets.length === 0;
  targets.forEach((target, i) => {
    const res = results[i];
    if (res.error !== undefined) {
      errors.push({ repo: target.repo.name, message: res.error });
      prs.push(...(previous?.prs ?? []).filter((p) => p.repoRoot === target.repo.root));
      return;
    }
    answered = true;
    prs.push(...prsForTicket(res.prs, ticket, new Set(target.branches)));
  });

  const seen = new Set<string>();
  const unique = sortPullRequests(prs).filter((p) => !seen.has(p.url) && seen.add(p.url));
  const snap: PrSnapshot = { ticket: key, ...(answered ? { fetchedAt: now.toISOString() } : previous?.fetchedAt ? { fetchedAt: previous.fetchedAt } : {}), prs: unique, errors };
  writePrSnapshot(dir, snap);
  return snap;
}
