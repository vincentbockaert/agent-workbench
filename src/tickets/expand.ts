import { RepoInfo } from '../git/repos';
import { TicketSourceConfig } from './source';

// A configured source resolved for the current window: where to run it and under which name it is stored.
export interface EffectiveSource {
  cfg: TicketSourceConfig; // `name` is the effective name; it keys snapshots, ticket status and time
  cwd: string;
  repo?: RepoInfo; // set for repo-scoped sources; undefined for workspace-scoped ones
}

// "repo" sources (the default) run once in each repo; "workspace" sources run once in the window root.
// With a single repo, names stay as configured, so snapshots, statuses and time logs of a one-repo window
// are unchanged. With several repos the repo folder name is appended, so `#12` of two repos never collide.
export function expandSources(configs: TicketSourceConfig[], repos: RepoInfo[], rootCwd: string): EffectiveSource[] {
  const out: EffectiveSource[] = [];
  for (const cfg of configs) {
    if (cfg.scope === 'workspace') {
      out.push({ cfg, cwd: rootCwd });
    } else if (repos.length === 0) {
      out.push({ cfg, cwd: rootCwd });
    } else if (repos.length === 1) {
      out.push({ cfg, cwd: repos[0].root, repo: repos[0] });
    } else {
      for (const repo of repos) {
        out.push({ cfg: { ...cfg, name: `${cfg.name} · ${repo.name}` }, cwd: repo.root, repo });
      }
    }
  }
  return out;
}

// The repos a new session for a ticket of `sourceName` (or an ad-hoc session, `undefined`) may start in:
// the ticket's own repo for a repo-scoped source, otherwise every repo (the caller asks when there are several).
export function candidateRepos(sourceName: string | undefined, sources: EffectiveSource[], repos: RepoInfo[]): RepoInfo[] {
  const own = sourceName === undefined ? undefined : sources.find((s) => s.cfg.name === sourceName)?.repo;
  return own ? [own] : repos;
}
