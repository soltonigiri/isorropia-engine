import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IsorropiaEngine,
  formatPairResponse,
  loadDataset,
  validateDataset,
} from '../dist/index.js';

const dataset = await loadDataset();
const engine = new IsorropiaEngine(dataset);

test('the fixed dataset satisfies the MVP completion gates', () => {
  assert.deepEqual(validateDataset(dataset), { valid: true, errors: [] });
});

test('the reference end-of-death cycle is ranked first with source evidence', () => {
  const response = engine.pair({ pageId: '3984', mode: 'cycle' });
  assert.equal(response.results[0].page_id, 'scp-2935');
  assert.equal(response.results[0].score, 100);
  assert.equal(response.results[0].evidence.candidate.section, 'Description');
  assert.equal(response.disclaimer, 'Containment hypothesis — not canonical.');
});

test('the same input and dataset produce byte-identical JSON', () => {
  const first = JSON.stringify(engine.pair({ pageId: 'scp-055', mode: 'breach' }));
  const second = JSON.stringify(engine.pair({ pageId: 'scp-055', mode: 'breach' }));
  assert.equal(first, second);
});

test('SCP-914 settings only filter by confidence', () => {
  const normal = engine.pair({ pageId: 'scp-008', mode: 'breach', limit: 99 });
  const fine = engine.pair({
    pageId: 'scp-008',
    mode: 'breach',
    limit: 99,
    setting: 'fine',
  });
  assert.ok(fine.results.length <= normal.results.length);
  assert.ok(fine.results.every((result) => result.confidence >= 0.7));
  for (const result of fine.results) {
    assert.deepEqual(
      result,
      normal.results.find((candidate) => candidate.page_id === result.page_id),
    );
  }
});

test('double-feature scoring ignores internal and editorial tags', () => {
  const response = engine.pair({
    pageId: 'scp-914',
    mode: 'double-feature',
    limit: 99,
    setting: 'rough',
  });
  const scp002 = response.results.find((result) => result.page_id === 'scp-002');
  assert.ok(scp002);
  assert.equal(
    scp002.rules.some((rule) => rule.id === 'double-shared-tags'),
    false,
  );
  assert.equal(
    [scp002.evidence.query.locator, scp002.evidence.candidate.locator].includes(
      'tag:_cc',
    ),
    false,
  );
});

test('qualitative breach interactions outrank tag-only matches and preserve assumptions', () => {
  const response = engine.pair({ pageId: 'scp-008', mode: 'breach' });

  assert.deepEqual(
    response.results.map((result) => result.page_id),
    ['scp-610', 'scp-217', 'scp-871'],
  );
  assert.match(response.results[2].rules[0].explanation, /does not infect the cakes/);
  assert.match(response.results[2].assumption, /personnel or supply chain/);
  assert.equal(response.results[2].confidence, 0.75);
});

test('reviewed negative interactions suppress misleading tag matches', () => {
  const normal = engine.pair({
    pageId: 'scp-008',
    mode: 'breach',
    limit: 99,
  });
  const rough = engine.pair({
    pageId: 'scp-008',
    mode: 'breach',
    limit: 99,
    setting: 'rough',
  });

  for (const response of [normal, rough]) {
    assert.equal(response.results.some((result) => result.page_id === 'scp-049'), false);
    assert.equal(response.results.some((result) => result.page_id === 'scp-7795'), false);
  }
});

test('default output returns only supported results while rough exposes weak signals', () => {
  const normal = engine.pair({ pageId: 'scp-3984', mode: 'cycle' });
  const rough = engine.pair({
    pageId: 'scp-3984',
    mode: 'cycle',
    setting: 'rough',
  });

  assert.deepEqual(normal.results.map((result) => result.page_id), ['scp-2935']);
  assert.ok(rough.results.length > normal.results.length);
  assert.ok(rough.results.slice(1).every((result) => result.confidence <= 0.55));
});

test('double-feature ranking follows reviewed narrative fit instead of page id', () => {
  const response = engine.pair({ pageId: 'scp-4010', mode: 'double-feature' });

  assert.deepEqual(
    response.results.map((result) => result.page_id),
    ['scp-3999', 'scp-2747', 'scp-5999', 'scp-3301', 'scp-239'],
  );
});

test('SCP-055 and SCP-2521 easter eggs preserve canonical data', () => {
  const fiftyFive = engine.pair({ pageId: 'scp-055', mode: 'cycle' });
  assert.deepEqual(fiftyFive.known_not, ['round']);

  const twentyFiveTwentyOne = engine.pair({
    pageId: 'scp-2521',
    mode: 'double-feature',
    limit: 1,
  });
  const human = formatPairResponse(twentyFiveTwentyOne);
  assert.match(human, /●●\|●●●●●\|●●\|●/);
  assert.match(human, /scp-2521/);
  assert.equal(twentyFiveTwentyOne.query.page_id, 'scp-2521');
});

test('Central Containment resolves the strongest deterministic cycle', () => {
  const core = engine.coreCycle();
  assert.deepEqual(core.cycle, ['scp-2935', 'scp-3984']);
  assert.equal(core.minimum_edge_score, 100);
  assert.equal(core.average_edge_score, 100);
});
