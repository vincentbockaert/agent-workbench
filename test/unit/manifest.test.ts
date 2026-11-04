import { strict as assert } from 'assert';
import { VIEW_CONTAINER_ID, WORK_VIEW_ID } from '../../src/constants';
import manifest from '../../package.json';

describe('manifest', () => {
  it('is private so it cannot be published by accident', () => {
    assert.equal(manifest.private, true);
  });

  it('declares the view container and view ids the code uses', () => {
    const containers = manifest.contributes.viewsContainers.activitybar.map((c) => c.id);
    assert.deepEqual(containers, [VIEW_CONTAINER_ID]);
    const views = manifest.contributes.views[VIEW_CONTAINER_ID].map((v) => v.id);
    assert.deepEqual(views, [WORK_VIEW_ID]);
  });

  it('ships a GitHub example that satisfies the settings schema keys', () => {
    const example = require('../../src/tickets/examples/github.json');
    const schema = manifest.contributes.configuration.properties['agentWorkbench.ticketSources'].items;
    for (const key of schema.required) {
      assert.ok(key in example, `example misses "${key}"`);
    }
    for (const key of Object.keys(example)) {
      assert.ok(key in schema.properties, `example has unknown key "${key}"`);
    }
  });
});
