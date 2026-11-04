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
});
