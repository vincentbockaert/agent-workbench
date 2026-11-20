import * as vscode from 'vscode';
import { AgentOptions, AgentProfile, defaultOptions, OTHER, optionChoices, supportsOptions } from './profiles';

const SAFE = /^[A-Za-z0-9._:/@[\]-]+$/;

// agentWorkbench.agentDefaults, e.g. { "claude": { "model": "opus", "effort": "high" } }.
export function configuredOptions(profileId: string): AgentOptions | undefined {
  const all = vscode.workspace.getConfiguration('agentWorkbench').get<Record<string, AgentOptions>>('agentDefaults', {});
  const entry = all?.[profileId];
  return entry && typeof entry === 'object' ? entry : undefined;
}

export function defaultOptionsFor(profile: AgentProfile): AgentOptions {
  return defaultOptions(profile, configuredOptions(profile.id));
}

// A model pick, then an effort pick, each with the preselected value first so Enter accepts it.
// undefined = cancelled; {} = the agent's own defaults (or a profile that takes no options).
export async function pickAgentOptions(profile: AgentProfile, lastUsed: AgentOptions, title: string): Promise<AgentOptions | undefined> {
  if (!supportsOptions(profile)) {
    return {};
  }
  const configured = configuredOptions(profile.id);
  const out: AgentOptions = {};
  const steps = [
    ['model', profile.modelArg, profile.models ?? [], lastUsed.model, configured?.model, profile.defaultModel],
    ['effort', profile.effortArg, profile.efforts ?? [], lastUsed.effort, configured?.effort, profile.defaultEffort],
  ] as const;
  for (const [kind, arg, values, last, conf, def] of steps) {
    if (!arg) {
      continue;
    }
    const picked = await vscode.window.showQuickPick(
      optionChoices([...values], { lastUsed: last, configured: conf, profileDefault: def }).map((c) => ({ label: c.label, description: c.description, value: c.value })),
      { title: `${title} — ${profile.label} ${kind}`, placeHolder: `Which ${kind}? Enter keeps the first one.` },
    );
    if (!picked) {
      return undefined;
    }
    let value = picked.value;
    if (value === OTHER) {
      value = await vscode.window.showInputBox({
        title: `${profile.label} ${kind}`,
        prompt: kind === 'model' ? 'A model alias or full name, e.g. claude-sonnet-5-5' : 'An effort level the agent accepts',
        validateInput: (v) => (SAFE.test(v.trim()) ? undefined : 'One word: letters, digits and . _ : / @ [ ] -'),
      });
      if (value === undefined) {
        return undefined;
      }
      value = value.trim();
    }
    if (value !== undefined) {
      out[kind] = value;
    }
  }
  return out;
}
