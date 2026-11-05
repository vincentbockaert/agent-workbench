import { execFile } from 'child_process';
import { GH_PR_FIELDS, parsePullRequests, PullRequest } from './model';

export interface RepoRef {
  name: string;
  root: string;
}

export interface FetchResult {
  prs: PullRequest[];
  error?: string; // shown in the ticket tab; the previous PRs of this repo stay visible
  noRemote?: boolean; // the repo has no GitHub remote: nothing to show, and nothing to complain about
}

export interface FetchOptions {
  gh?: string; // the executable; tests point it at a fake
  timeoutMs?: number;
}

// All PRs of one repository (open, draft, merged, closed; the latest 100) through the `gh` CLI, using its own login.
// Read-only: it only lists. Never throws; problems come back as `error`.
export function fetchRepoPullRequests(repo: RepoRef, opts: FetchOptions = {}): Promise<FetchResult> {
  const { gh = 'gh', timeoutMs = 30_000 } = opts;
  return new Promise((resolve) => {
    execFile(
      gh,
      ['pr', 'list', '--state', 'all', '--limit', '100', '--json', GH_PR_FIELDS],
      { cwd: repo.root, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          resolve(classify(err, String(stderr)));
          return;
        }
        try {
          resolve({ prs: parsePullRequests(JSON.parse(String(stdout)), repo) });
        } catch {
          resolve({ prs: [], error: 'unreadable output from gh' });
        }
      },
    );
  });
}

function classify(err: { code?: unknown; killed?: boolean; message: string }, stderr: string): FetchResult {
  if (err.code === 'ENOENT') {
    return { prs: [], error: 'gh is not installed (https://cli.github.com)' };
  }
  if (err.killed) {
    return { prs: [], error: 'gh timed out' };
  }
  if (/none of the git remotes|no git remotes/i.test(stderr)) {
    return { prs: [], noRemote: true };
  }
  if (/gh auth login|not logged in|authentication required/i.test(stderr)) {
    return { prs: [], error: 'gh is not logged in: run `gh auth login`' };
  }
  const firstLine = stderr.split(/\r?\n/).find((l) => l.trim() !== '');
  return { prs: [], error: firstLine?.trim() ?? err.message };
}
