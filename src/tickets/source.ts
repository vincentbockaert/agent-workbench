import { exec } from 'child_process';

// A ticket source is configuration, not code: a shell command that prints JSON,
// plus a map from ticket fields to dotted paths in each JSON item.
export interface TicketSourceConfig {
  name: string;
  listCmd: string;
  // Dotted path to the array of items when the command prints an object (e.g. "issues"); omit for a top-level array.
  itemsPath?: string;
  // Optional: shell command that logs one worklog entry; it reads WB_TICKET_ID, WB_DATE, WB_MINUTES, WB_NOTE etc.
  logCmd?: string;
  map: {
    id: string;
    title: string;
    status?: string;
    url?: string;
    description?: string;
  };
}

export interface Ticket {
  source: string;
  id: string;
  title: string;
  status?: string;
  url?: string;
  description?: string;
  raw: unknown;
}

export function mapTickets(json: unknown, cfg: TicketSourceConfig): Ticket[] {
  const items = cfg.itemsPath ? getPath(json, cfg.itemsPath) : json;
  if (!Array.isArray(items)) {
    const where = cfg.itemsPath ? `"${cfg.itemsPath}"` : 'the output';
    throw new Error(`expected ${where} to be an array of tickets`);
  }
  return items.map((item, i) => {
    const description = optional(item, cfg.map.description);
    return {
      source: cfg.name,
      id: required(item, cfg.map.id, i, 'id'),
      title: required(item, cfg.map.title, i, 'title'),
      status: optional(item, cfg.map.status),
      url: optional(item, cfg.map.url),
      ...(description !== undefined ? { description } : {}),
      raw: item,
    };
  });
}

// Runs the configured command through the shell (it is the user's own config, and trackers'
// CLIs need quoting), with the workspace folder as cwd.
export function fetchTickets(cfg: TicketSourceConfig, cwd: string, timeoutMs = 30000): Promise<Ticket[]> {
  return new Promise((resolve, reject) => {
    exec(cfg.listCmd, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const detail = stderr.trim() || err.message;
        reject(new Error(`"${cfg.name}" command failed (exit ${err.code ?? err.signal}): ${detail}`));
        return;
      }
      let json: unknown;
      try {
        json = JSON.parse(stdout);
      } catch (e) {
        reject(new Error(`"${cfg.name}" output is not valid JSON: ${(e as Error).message}`));
        return;
      }
      try {
        resolve(mapTickets(json, cfg));
      } catch (e) {
        reject(new Error(`"${cfg.name}": ${(e as Error).message}`));
      }
    });
  });
}

function getPath(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const key of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object') {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function optional(item: unknown, dotted: string | undefined): string | undefined {
  if (!dotted) {
    return undefined;
  }
  const v = getPath(item, dotted);
  return v === undefined || v === null || v === '' ? undefined : String(v);
}

function required(item: unknown, dotted: string, index: number, field: string): string {
  const v = optional(item, dotted);
  if (v === undefined) {
    throw new Error(`item ${index} has no ${field} at "${dotted}"`);
  }
  return v;
}
