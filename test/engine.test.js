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

test('all runtime effects are compiled from article evidence with canonical aliases', () => {
  assert.ok(dataset.profiles.every((profile) =>
    profile.effects.length > 0 && profile.effects.every((effect) => effect.evidence.section !== 'metadata.tags')));
  const scp002 = dataset.profiles.find((profile) => profile.page_id === 'scp-002');
  assert.ok(scp002.effects.some((effect) => effect.domain === 'biology' && effect.operation === 'transform'));
});

test('the reference death-boundary balance is ranked first with source evidence', () => {
  const response = engine.pair({ pageId: '3984', mode: 'cycle' });
  assert.equal(response.results[0].page_id, 'scp-2935');
  assert.equal(response.results[0].score, 90);
  assert.equal(response.results[0].evidence.candidate.section, 'Description');
  assert.equal(response.disclaimer, 'Containment hypothesis — not canonical.');
});

test('rich terminal output is structured, scannable, and width-bounded', () => {
  const response = engine.pair({ pageId: 'scp-002', mode: 'double-feature', limit: 2 });
  const output = formatPairResponse(response, {
    rich: true,
    color: false,
    width: 78,
  });

  assert.match(output, /╭━+╮/);
  assert.match(output, /DOUBLE-FEATURE ANALYSIS/);
  assert.match(output, /CONFIDENCE  █+░+  0\.90/);
  assert.match(output, /SCORE 100/);
  assert.match(output, /READ\s+https:\/\/scp-wiki\.wikidot\.com\/scp-184/);
  assert.equal(output.includes('RULES'), false);
  assert.equal(output.includes('QUERY'), false);
  assert.match(output, /━{20,}/);
  assert.equal(
    output.split('\n').every((line) => Array.from(line).length <= 78),
    true,
  );
});

test('explain output adds the scoring basis and source locations', () => {
  const response = engine.pair({ pageId: 'scp-002', mode: 'double-feature', limit: 1 });
  const output = formatPairResponse(response, {
    rich: true, color: false, width: 78, explain: true,
  });
  assert.match(output, /BASIS\s+reviewed · support A/);
  assert.match(output, /RULES\s+auto-double-feature-scp-002-scp-184/);
  assert.match(output, /CONDITION\s+Both anomalies can be curated/);
  assert.match(output, /QUERY\s+rev\.78/);
  assert.match(output, /MATCH\s+rev\.54/);
});

test('plain output remains available for pipes and narrow terminals', () => {
  const response = engine.pair({ pageId: 'scp-002', mode: 'double-feature', limit: 1 });
  const output = formatPairResponse(response, { rich: false });

  assert.equal(output.includes('╭'), false);
  assert.match(output, /score=100 confidence=0\.90/);
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
  const response = engine.pair({ pageId: 'scp-012', mode: 'breach' });

  assert.equal(response.results[0].page_id, 'scp-140');
  assert.equal(response.results[0].basis.kind, 'reviewed-interaction');
  assert.equal(response.results[0].basis.support_grade, 'B');
  assert.match(response.results[0].assumption, /contacts SCP-140/);
  assert.equal(response.results[0].confidence, 0.75);
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
    assert.equal(response.results.some((result) => result.page_id === 'scp-217'), false);
    assert.equal(response.results.some((result) => result.page_id === 'scp-871'), false);
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
  const response = engine.pair({ pageId: 'scp-002', mode: 'double-feature' });

  assert.deepEqual(
    response.results.map((result) => result.page_id),
    ['scp-184', 'scp-198'],
  );
  const rough = engine.pair({
    pageId: 'scp-002', mode: 'double-feature', setting: 'rough', limit: 99,
  });
  assert.deepEqual(
    rough.results.slice(0, 5).map((result) => result.page_id),
    ['scp-184', 'scp-198', 'scp-035', 'scp-426', 'scp-040'],
  );
});

test('article-specific human formatting preserves canonical data', () => {
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
  assert.equal(core.minimum_edge_score, 90);
  assert.equal(core.average_edge_score, 90);
});

test('cycle accepts mutual constraint and rejects an unproved renewal link', () => {
  const accepted = engine.inspect({
    pageId: 'scp-2935', candidatePageId: 'scp-3984', mode: 'cycle',
  });
  const rejected = engine.inspect({
    pageId: 'scp-073', candidatePageId: 'scp-682', mode: 'cycle',
  });
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.result.basis.kind, 'reviewed-interaction');
  assert.equal(rejected.status, 'rejected');
  assert.match(rejected.reason, /supplies no counteracting link/);
});

test('direction reversal preserves the same reviewed score and swaps evidence ownership', () => {
  const forward = engine.inspect({
    pageId: 'scp-2935', candidatePageId: 'scp-3984', mode: 'cycle',
  });
  const reverse = engine.inspect({
    pageId: 'scp-3984', candidatePageId: 'scp-2935', mode: 'cycle',
  });
  assert.equal(forward.result.score, reverse.result.score);
  assert.equal(forward.result.evidence.query.revision, 93);
  assert.equal(reverse.result.evidence.query.revision, 46);
});

test('support grades and an exact threshold boundary are enforced', () => {
  const support = new Set();
  for (const profile of dataset.profiles) {
    for (const mode of ['cycle', 'breach', 'double-feature']) {
      for (const result of engine.pair({ pageId: profile.page_id, mode, limit: 99 }).results) {
        if (result.basis.kind === 'reviewed-interaction') support.add(result.basis.support_grade);
      }
    }
  }
  assert.deepEqual([...support].sort(), ['A', 'B']);

  const roughSupport = new Set();
  for (const profile of dataset.profiles) {
    for (const mode of ['cycle', 'breach', 'double-feature']) {
      for (const result of engine.pair({
        pageId: profile.page_id, mode, setting: 'rough', limit: 99,
      }).results) {
        if (result.basis.kind === 'reviewed-interaction') {
          roughSupport.add(result.basis.support_grade);
        }
      }
    }
  }
  assert.deepEqual([...roughSupport].sort(), ['A', 'B', 'C']);

  const boundaryDataset = structuredClone(dataset);
  boundaryDataset.scoringPolicy.support_confidence.C = 0.5;
  const boundary = new IsorropiaEngine(boundaryDataset);
  assert.equal(boundary.inspect({
    pageId: 'scp-073', candidatePageId: 'scp-076', mode: 'cycle',
  }).result.confidence, 0.5);
  assert.equal(boundary.pair({ pageId: 'scp-073', mode: 'cycle', limit: 99 })
    .results.some((result) => result.page_id === 'scp-076'), true);
});

test('ties use page id after score and confidence', () => {
  const rough = engine.pair({
    pageId: 'scp-002', mode: 'cycle', setting: 'rough', limit: 99,
  }).results;
  const groups = Map.groupBy(rough, (result) => `${result.score}/${result.confidence}`);
  const tied = [...groups.values()].find((items) => items.length > 1);
  assert.ok(tied);
  assert.deepEqual(
    tied.map((result) => result.page_id),
    tied.map((result) => result.page_id).sort(),
  );
});

test('rule version changes when the scoring policy changes', () => {
  const changed = structuredClone(dataset);
  changed.scoringPolicy.rubric_points.discovery_value.low += 1;
  assert.notEqual(new IsorropiaEngine(changed).ruleVersion, engine.ruleVersion);
});
