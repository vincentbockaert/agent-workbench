import * as vscode from 'vscode';
import { ClockTracker } from '../time/clock';
import { renderClockBar, shortLabel } from '../time/clockbar';
import { Totals } from '../time/compute';

const TICK_MS = 10_000;
export const TIMER_MENU_COMMAND = 'agentWorkbench.timerMenu';

// The status bar item for the work-item clock: ▶ the ticket you work in, ⏸ the others, with today's time.
export class ClockStatus implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  private ticking?: NodeJS.Timeout;
  private titles: Record<string, string> = {};

  constructor(
    private readonly clock: ClockTracker,
    private readonly live: () => Record<string, Totals>,
    private readonly loadTitles: () => Record<string, string>,
  ) {
    this.item.command = TIMER_MENU_COMMAND;
    this.refresh();
    this.item.show();
  }

  // Titles are looked up when the clock changes, not on every tick, because that reads snapshot files.
  refresh(reloadTitles = true): void {
    if (reloadTitles) {
      this.titles = this.loadTitles();
    }
    const state = this.clock.state();
    const totals = this.live();
    const bar = renderClockBar(state, (key) => totals[key]?.timerMs ?? 0, (key) => shortLabel(key, this.titles), this.titles);
    this.item.text = bar.text;
    this.item.tooltip = bar.tooltip;
    // Tick only while time is accruing.
    if (state.active !== undefined && !this.ticking) {
      this.ticking = setInterval(() => this.refresh(false), TICK_MS);
    } else if (state.active === undefined && this.ticking) {
      clearInterval(this.ticking);
      this.ticking = undefined;
    }
  }

  dispose(): void {
    if (this.ticking) {
      clearInterval(this.ticking);
    }
    this.item.dispose();
  }
}
