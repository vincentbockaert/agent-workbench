import { strict as assert } from 'assert';
import { lastOptions } from '../../src/agents/choices';
import manifest from '../../package.json';
import { AgentProfile, agentCommand, DEFAULT_PROFILES, defaultOptions, mergeProfiles, OTHER, optionChoices, supportsOptions } from '../../src/agents/profiles';

const claude = DEFAULT_PROFILES.find((p) => p.id === 'claude')!;
const codex = DEFAULT_PROFILES.find((p) => p.id === 'codex')!;
const vars = { sessionId: 'github-42-1', branch: 'wb/github-42-1' };

describe('agent model and effort', () => {
  describe('agentCommand with options', () => {
    it('puts the model and effort flags where ${options} is, quoted', () => {
      assert.equal(agentCommand(claude, 'start-bare', vars, { model: 'sonnet', effort: 'medium' }), "claude --model 'sonnet' --effort 'medium' -n github-42-1");
      assert.match(agentCommand(claude, 'start', vars, { model: 'opus' }), /^claude --model 'opus' -n github-42-1 "Read /);
      assert.equal(agentCommand(claude, 'resume', vars, { effort: 'low' }), "claude --effort 'low' --continue");
    });

    it('adds nothing, not even a space, without a choice (the agent uses its own default)', () => {
      assert.equal(agentCommand(claude, 'start-bare', vars, {}), 'claude -n github-42-1');
      assert.equal(agentCommand(claude, 'resume', vars), 'claude --continue');
    });

    it('quotes full model names with brackets, so zsh does not glob them', () => {
      assert.equal(agentCommand(claude, 'start-bare', vars, { model: 'claude-opus-5-5[1m]' }), "claude --model 'claude-opus-5-5[1m]' -n github-42-1");
    });

    it('refuses values that could break out of the quotes', () => {
      for (const bad of ["x'; rm -rf ~", 'a b', '$(id)', '']) {
        assert.throws(() => agentCommand(claude, 'start-bare', vars, { model: bad }), /model/);
      }
    });

    it('passes codex options its own way', () => {
      assert.equal(agentCommand(codex, 'start-bare', vars, { model: 'gpt-5-codex', effort: 'high' }), "codex -m 'gpt-5-codex' -c model_reasoning_effort='high'");
    });
  });

  describe('profiles', () => {
    it('lets the built-in agents take a model and effort, Claude with sonnet and medium as its own default', () => {
      assert.ok(supportsOptions(claude) && supportsOptions(codex));
      assert.deepEqual([claude.defaultModel, claude.defaultEffort], ['sonnet', 'medium']);
      assert.deepEqual(claude.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
    });

    it('does not offer a choice for a profile without ${options} in its start command', () => {
      const aider: AgentProfile = { id: 'aider', label: 'Aider', startCmd: 'aider', modelArg: '--model ${value}' };
      assert.equal(supportsOptions(aider), false);
    });

    it('validates the new profile fields', () => {
      const { problems } = mergeProfiles([
        { id: 'a', label: 'A', startCmd: 'a ${options}', modelArg: '--model' },
        { id: 'b', label: 'B', startCmd: 'b ${options}', models: ['ok', 'not ok'] },
        { id: 'c', label: 'C', startCmd: 'c ${options}', modelArg: '--model ${value}', models: ['m1'], defaultModel: 'm1' },
      ]);
      assert.equal(problems.length, 2);
      assert.match(problems[0], /a: "modelArg" must contain \$\{value\}/);
      assert.match(problems[1], /b: "models"/);
    });
  });

  describe('optionChoices', () => {
    it('preselects the last used value on this ticket, then the configured default, then the profile default', () => {
      assert.equal(optionChoices(claude.models!, { lastUsed: 'opus', configured: 'haiku', profileDefault: 'sonnet' })[0].value, 'opus');
      assert.equal(optionChoices(claude.models!, { configured: 'haiku', profileDefault: 'sonnet' })[0].value, 'haiku');
      assert.equal(optionChoices(claude.models!, { profileDefault: 'sonnet' })[0].value, 'sonnet');
      assert.equal(optionChoices(claude.models!, {})[0].value, undefined, "no default: the agent's own");
    });

    it("lists each value once, then the agent's own default and Other…", () => {
      const c = optionChoices(['sonnet', 'opus'], { lastUsed: 'opus', profileDefault: 'sonnet' });
      assert.deepEqual(c.map((x) => x.value), ['opus', 'sonnet', undefined, OTHER]);
      assert.equal(c[0].description, 'last used on this ticket');
      assert.equal(c[1].description, 'default');
    });

    it('keeps a typed value that is not in the list as the preselected one', () => {
      assert.deepEqual(optionChoices(['sonnet'], { lastUsed: 'claude-opus-5-5[1m]' }).map((x) => x.value), ['claude-opus-5-5[1m]', 'sonnet', undefined, OTHER]);
    });
  });

  describe('lastOptions', () => {
    const s = (id: string, ticketId: string | undefined, agent: string | undefined, extra: object = {}) => ({
      id, repo: '/r', worktree: `/w/${id}`, branch: `wb/${id}`, baseRef: 'main', createdAt: 't',
      ...(ticketId ? { ticket: { source: 'Jira', id: ticketId, title: 'T' } } : {}), ...(agent ? { agent } : {}), ...extra,
    });

    it("takes the newest session of this ticket with this agent, and ignores other tickets and agents", () => {
      const sessions = [
        s('a', 'P-1', 'claude', { model: 'opus', effort: 'high' }),
        s('b', 'P-1', 'claude', { model: 'haiku' }),
        s('c', 'P-1', 'codex', { model: 'gpt-5' }),
        s('d', 'P-2', 'claude', { model: 'fable', effort: 'max' }),
      ];
      assert.deepEqual(lastOptions(sessions, { source: 'Jira', id: 'P-1' }, 'claude'), { model: 'haiku' });
      assert.deepEqual(lastOptions(sessions, { source: 'Jira', id: 'P-3' }, 'claude'), {});
      assert.deepEqual(lastOptions(sessions, undefined, 'claude'), {}, 'ad-hoc work has no history to go by');
    });
  });

  describe('defaultOptions', () => {
    it('uses your configured default per agent over the profile default, and only for what the agent can take', () => {
      assert.deepEqual(defaultOptions(claude, undefined), { model: 'sonnet', effort: 'medium' });
      assert.deepEqual(defaultOptions(claude, { model: 'opus' }), { model: 'opus', effort: 'medium' });
      assert.deepEqual(defaultOptions(codex, undefined), {});
      assert.deepEqual(defaultOptions({ id: 'x', label: 'X', startCmd: 'x ${options}', effortArg: '-e ${value}' }, { model: 'm', effort: 'low' }), { effort: 'low' });
    });
  });

  it('declares the settings and the new profile fields in the manifest', () => {
    const props = (manifest as any).contributes.configuration.properties;
    assert.deepEqual(props['agentWorkbench.agentDefaults'].default, {});
    const fields = Object.keys(props['agentWorkbench.agents'].items.properties);
    for (const f of ['modelArg', 'effortArg', 'models', 'efforts', 'defaultModel', 'defaultEffort']) {
      assert.ok(fields.includes(f), f);
    }
    const commands = (manifest as any).contributes.commands.map((c: { command: string }) => c.command);
    assert.ok(commands.includes('agentWorkbench.changeAgentOptions'));
  });
});
