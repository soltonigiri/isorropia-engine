import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadDataset, validateDataset } from '../dist/index.js';
import { interactionSemanticDigest } from '../dist/analysis-policy.js';
import { assertDatasetFile } from '../dist/raw-validation.js';

test('persisted semantics require source and ontology provenance', () => {
  const semantic = {
    page_id: 'scp-001',
    source_revision: 1,
    claims: [{
      id: 'article-effect',
      kind: 'effect',
      domain: 'information',
      operation: 'preserve',
      outcomes: ['preserved'],
      preconditions: [],
      limitations: [],
      evidence: [{ revision: 1, section: 'Description', locator: 'Exact article evidence.' }],
      role: 'anomalous-effect',
      operation_class: 'other',
      domain_class: 'information',
      affected_state: 'information-state',
      direction: 'preserve',
      chunk_ids: ['1/1'],
    }],
    reviewed_modes: ['cycle', 'breach', 'double-feature'],
  };

  assert.throws(
    () => assertDatasetFile([semantic], 'semantics', 'semantics.json'),
    /semantics\.json:\$\[0\]\.schema_version: expected finite number/,
  );
});

test('persisted rejected interactions still require generation provenance', () => {
  assert.throws(
    () => assertDatasetFile([{
      id: 'rejected-cycle',
      pages: ['scp-001', 'scp-002'],
      mode: 'cycle',
      source_revisions: { 'scp-001': 1, 'scp-002': 1 },
      verdict: 'rejected',
      reason: 'The effects do not counteract one another.',
    }], 'interactions', 'interactions.json'),
    /interactions\.json:\$\[0\]\.semantic_digests: expected object/,
  );
});

test('raw data errors name the file and JSON path', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'isorropia-raw-data-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  await cp(new URL('../data/', import.meta.url), data, { recursive: true });
  const file = path.join(data, 'profiles', 'scp-002.json');
  const profile = JSON.parse(await readFile(file, 'utf8'));
  profile.effects[0].operation = 42;
  await writeFile(file, `${JSON.stringify(profile, null, 2)}\n`);
  await assert.rejects(loadDataset(data), /scp-002\.json:\$\.effects\[0\]\.operation: expected string/);
});

test('validation requires one fully reviewed semantic profile per catalog profile', async () => {
  const dataset = structuredClone(await loadDataset());
  dataset.semantics = dataset.semantics.slice(1);
  const validation = validateDataset(dataset);
  assert.ok(validation.errors.includes('Missing semantic profile: scp-002'));
});

test('the 100 article-reviewed qualitative cases remain a bounded evaluation set', async () => {
  const dataset = await loadDataset();
  const cases = JSON.parse(await readFile(
    new URL('./fixtures/qualitative-cases.json', import.meta.url),
    'utf8',
  ));
  assert.equal(cases.length, 100);
  assert.equal(new Set(cases.map((item) =>
    `${item.mode}:${[...item.pages].sort().join(':')}`)).size, 100);

  const semantics = new Set(dataset.semantics.map((item) => item.page_id));
  for (const item of cases) {
    const key = `${item.mode}:${[...item.pages].sort().join(':')}`;
    assert.ok(['keep', 'reject', 'revise', 'defer'].includes(item.decision), key);
    for (const pageId of item.pages) {
      assert.ok(semantics.has(pageId), `${key}/${pageId}`);
      assert.equal(Number.isInteger(item.source_revisions[pageId]), true, `${key}/${pageId}`);
    }
    if (item.maximum_support) {
      assert.ok(['A', 'B', 'C'].includes(item.maximum_support), key);
    }
  }
});

test('interactions require policy and semantic provenance', async () => {
  const dataset = structuredClone(await loadDataset());
  const interaction = dataset.interactions.find((item) => item.verdict === 'accepted');
  assert.ok(interaction);
  delete interaction.review_policy_digest;
  const validation = validateDataset(dataset);
  assert.ok(validation.errors.includes(
    `Interaction has no policy provenance: ${interaction.id}`,
  ));
});

test('candidate provenance remains historical while review provenance must be current', async () => {
  const dataset = structuredClone(await loadDataset());
  const interaction = dataset.interactions.find((item) => item.verdict === 'accepted');
  assert.ok(interaction);
  interaction.candidate_policy_digest = 'historical-policy';
  let validation = validateDataset(dataset);
  assert.equal(validation.errors.includes(`Interaction policy is stale: ${interaction.id}`), false);

  interaction.review_policy_digest = 'historical-review';
  validation = validateDataset(dataset);
  assert.ok(validation.errors.includes(`Interaction policy is stale: ${interaction.id}`));
});

test('a stale rejected review remains historical rather than blocking the dataset', async () => {
  const dataset = structuredClone(await loadDataset());
  const interaction = dataset.interactions.find((item) => item.verdict === 'rejected');
  assert.ok(interaction);
  interaction.review_policy_digest = 'historical-review';

  const validation = validateDataset(dataset);

  assert.equal(validation.errors.includes(`Interaction policy is stale: ${interaction.id}`), false);
});

test('interaction semantic digest ignores maintenance bookkeeping only', async () => {
  const dataset = await loadDataset();
  const semantic = dataset.semantics[0];
  const bookkeepingChange = {
    ...semantic,
    semantic_policy_digest: 'new-policy',
    reviewed_modes: [...semantic.reviewed_modes].reverse(),
  };
  assert.equal(interactionSemanticDigest(bookkeepingChange), interactionSemanticDigest(semantic));
  assert.notEqual(
    interactionSemanticDigest({
      ...semantic,
      coverage: { ...semantic.coverage, status: 'partial' },
    }),
    interactionSemanticDigest(semantic),
  );
});
