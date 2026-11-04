import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import manifest from '../../package.json';
import { mapTickets, TicketSourceConfig } from '../../src/tickets/source';

// Each shipped example is checked against a sample of what its command prints.
// The samples follow each tracker's documented JSON; the acli one follows the REST issue shape (see README).
const examples = path.join(__dirname, '..', '..', 'src', 'tickets', 'examples');
const samples = path.join(__dirname, '..', 'fixtures', 'examples');
const load = (dir: string, name: string) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));

const expected: Record<string, { sample: string; first: { id: string; title: string; status?: string; url?: string; description?: string } }> = {
  'github.json': { sample: 'github.json', first: { id: '42', title: 'Crash on empty config', status: 'OPEN', url: 'https://github.com/acme/web/issues/42', description: 'Steps:\n1. run with {}\n2. crash' } },
  'gitlab.json': { sample: 'gitlab.json', first: { id: '12', title: 'Rate-limit webhooks', status: 'opened', url: 'https://gitlab.com/acme/api/-/issues/12', description: 'Throttle to 10/s per tenant.' } },
  'jira-rest.json': { sample: 'jira-rest.json', first: { id: 'PROJ-123', title: 'Export report as CSV', status: 'In Progress' } },
  'jira-acli.json': { sample: 'jira-acli.json', first: { id: 'PROJ-123', title: 'Export report as CSV', status: 'In Progress' } },
  'trello.json': { sample: 'trello.json', first: { id: '7', title: 'Write a README for the greeter', url: 'https://trello.com/c/AbCd1234', description: 'Cover install and usage.' } },
};

describe('examples', () => {
  it('ships exactly the examples that are tested', () => {
    assert.deepEqual(fs.readdirSync(examples).sort(), Object.keys(expected).sort());
  });

  for (const [file, { sample, first }] of Object.entries(expected)) {
    describe(file, () => {
      const cfg = () => load(examples, file) as TicketSourceConfig;

      it('uses only keys the settings schema knows', () => {
        const schema = manifest.contributes.configuration.properties['agentWorkbench.ticketSources'].items;
        for (const key of schema.required) {
          assert.ok(key in cfg(), `misses "${key}"`);
        }
        for (const key of Object.keys(cfg())) {
          assert.ok(key in schema.properties, `unknown key "${key}"`);
        }
        for (const key of Object.keys(cfg().map)) {
          assert.ok(key in schema.properties.map.properties, `unknown map key "${key}"`);
        }
      });

      it('maps the sample output to tickets', () => {
        const tickets = mapTickets(load(samples, sample), cfg());
        assert.equal(tickets.length, 2);
        const { source, raw, ...fields } = tickets[0];
        assert.equal(source, cfg().name);
        assert.ok(raw);
        const defined = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
        assert.deepEqual(defined, first);
      });

      it('leaves an empty or null description out instead of showing "null"', () => {
        const second = mapTickets(load(samples, sample), cfg())[1];
        assert.notEqual(second.description, 'null');
        assert.notEqual(second.description, '');
      });
    });
  }
});
