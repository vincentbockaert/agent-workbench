import { formatDuration } from './report';

// "HDO-2064" for "Jira HDO:HDO-2064"; ad-hoc sessions have no id, so they are named by their title.
export function shortLabel(key: string, titles: Record<string, string>): string {
  if (key.startsWith('adhoc:')) {
    return titles[key] ?? key.slice('adhoc:'.length);
  }
  return key.slice(key.indexOf(':') + 1);
}

// Text of the status bar item: ▶ the ticket your attention is on, ⏸ the others on the clock, each with today's time.
export function renderClockBar(
  state: { onClock: string[]; active: string | undefined },
  timerMs: (key: string) => number,
  label: (key: string) => string,
  titles: Record<string, string>,
): { text: string; tooltip: string } {
  if (state.onClock.length === 0) {
    return { text: '$(watch) Timer off', tooltip: 'No work item is on the clock. Click to start one.' };
  }
  const text = state.onClock
    .map((key) => `${key === state.active ? '$(play)' : '$(debug-pause)'} ${label(key)} ${formatDuration(timerMs(key))}`)
    .join(' · ');
  const lines = state.onClock.map((key) => {
    const title = titles[key];
    return `${key === state.active ? 'Running' : 'Paused'}: ${label(key)}${title ? `: ${title}` : ''} (${formatDuration(timerMs(key))} today)`;
  });
  return { text, tooltip: `${lines.join('\n')}\n\nThe clock follows the ticket you work in. Click to stop or switch.` };
}
