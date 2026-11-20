import { exec } from 'child_process';
import { TicketSourceConfig } from './source';
import { WorkStatus } from './workflow';

const PLACEHOLDER = /\$\{(\w+)\}/g;

// Formats integer minutes as Jira/GitLab-friendly duration strings: "45m", "1h", "1h 30m".
export function formatTrackerDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h === 0) {
    return `${rem}m`;
  }
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

// Single-pass placeholder expansion for opt-in tracker write commands.
// Free-text values such as comments are passed via WB_COMMENT env var instead of shell interpolation.
export function expandTrackerCommand(template: string, vars: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (match, name: string) => {
    if (!(name in vars)) {
      throw new Error(`unknown placeholder ${match} (supported: ${Object.keys(vars).map((k) => `\${${k}}`).join(', ')})`);
    }
    return vars[name];
  });
}

export interface BookTimeInput {
  ticketId: string;
  day: string; // YYYY-MM-DD
  minutes: number;
  comment?: string;
}

export interface SyncStatusInput {
  ticketId: string;
  workStatus: WorkStatus;
}

function runShell(cmd: string, cwd: string, extraEnv: Record<string, string>, label: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(
      cmd,
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, ...extraEnv } },
      (err, stdout, stderr) => {
        if (err) {
          const detail = stderr.trim() || stdout.trim() || err.message;
          reject(new Error(`${label} failed (exit ${err.code ?? err.signal}): ${detail}`));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

export function buildLogTimeCommand(cfg: TicketSourceConfig, input: BookTimeInput): { cmd: string; env: Record<string, string> } {
  if (!cfg.logTimeCmd) {
    throw new Error(`ticket source "${cfg.name}" has no logTimeCmd configured`);
  }
  const minutes = Math.max(1, Math.round(input.minutes));
  const seconds = minutes * 60;
  const duration = formatTrackerDuration(minutes);
  const startedAt = `${input.day}T09:00:00.000+0000`;
  const vars: Record<string, string> = {
    id: input.ticketId,
    minutes: String(minutes),
    seconds: String(seconds),
    duration,
    day: input.day,
    startedAt,
  };
  const cmd = expandTrackerCommand(cfg.logTimeCmd, vars);
  const env: Record<string, string> = {
    WB_TICKET_ID: input.ticketId,
    WB_TICKET_SOURCE: cfg.name,
    WB_DAY: input.day,
    WB_MINUTES: String(minutes),
    WB_SECONDS: String(seconds),
    WB_DURATION: duration,
    WB_STARTED_AT: startedAt,
    WB_COMMENT: input.comment ?? '',
  };
  return { cmd, env };
}

export async function bookTimeToTracker(cfg: TicketSourceConfig, cwd: string, input: BookTimeInput, timeoutMs = 30000): Promise<string> {
  const { cmd, env } = buildLogTimeCommand(cfg, input);
  return runShell(cmd, cwd, env, `"${cfg.name}" logTimeCmd`, timeoutMs);
}

export function buildSetStatusCommand(
  cfg: TicketSourceConfig,
  input: SyncStatusInput,
): { trackerStatus: string; cmd: string; env: Record<string, string> } | undefined {
  if (!cfg.setStatusCmd) {
    return undefined;
  }
  const trackerStatus = cfg.statusMap?.[input.workStatus];
  if (!trackerStatus) {
    return undefined;
  }
  const vars: Record<string, string> = {
    id: input.ticketId,
    status: trackerStatus,
  };
  const cmd = expandTrackerCommand(cfg.setStatusCmd, vars);
  const env: Record<string, string> = {
    WB_TICKET_ID: input.ticketId,
    WB_TICKET_SOURCE: cfg.name,
    WB_STATUS: trackerStatus,
    WB_WORK_STATUS: input.workStatus,
  };
  return { trackerStatus, cmd, env };
}

export async function syncStatusToTracker(
  cfg: TicketSourceConfig,
  cwd: string,
  input: SyncStatusInput,
  timeoutMs = 30000,
): Promise<{ trackerStatus: string; stdout: string } | undefined> {
  const built = buildSetStatusCommand(cfg, input);
  if (!built) {
    return undefined;
  }
  const stdout = await runShell(built.cmd, cwd, built.env, `"${cfg.name}" setStatusCmd`, timeoutMs);
  return { trackerStatus: built.trackerStatus, stdout };
}
