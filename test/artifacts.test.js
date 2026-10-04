import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { buildArtifacts, IsorropiaEngine, loadDataset } from '../dist/index.js';

test('release artifacts contain the validated 100-profile dataset', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'isorropia-artifacts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'isorropia.sqlite.tmp'), 'interrupted build');
  const result = await buildArtifacts({ outputDirectory: directory });
  assert.equal(result.profile_count, 100);

  const json = JSON.parse(
    gunzipSync(await readFile(result.json)).toString('utf8'),
  );
  assert.equal(json.profiles.length, 100);
  assert.equal(json.manifest.attributions.length, 100);
  assert.ok(json.semantics.length >= 10);
  assert.ok(json.interactions.length >= 10);
  assert.equal(json.rankings['scp-008'].breach[0].page_id, 'scp-3008');
  assert.deepEqual(json.artifact_metadata, {
    artifact_schema_version: 3,
    ranking_setting: 'rough',
    default_confidence_threshold: 0.5,
    tool_version: '0.1.0',
    database_version: json.manifest.database_version,
    rule_version: json.artifact_metadata.rule_version,
    source_policy_digest: json.artifact_metadata.source_policy_digest,
    semantic_policy_digest: json.artifact_metadata.semantic_policy_digest,
    candidate_policy_digest: json.artifact_metadata.candidate_policy_digest,
    review_policy_digest: json.artifact_metadata.review_policy_digest,
    source_revision: 'unknown',
  });
  assert.match(json.artifact_metadata.rule_version, /^[a-f0-9]{12}$/);

  const dataset = await loadDataset();
  const engine = new IsorropiaEngine(dataset);
  for (const profile of dataset.profiles) {
    for (const mode of ['cycle', 'breach', 'double-feature']) {
      const artifactDefault = json.rankings[profile.page_id][mode]
        .filter((candidate) => candidate.confidence >= 0.5)
        .slice(0, 5)
        .map((candidate) => candidate.page_id);
      assert.deepEqual(
        artifactDefault,
        engine.pair({ pageId: profile.page_id, mode }).results.map((candidate) => candidate.page_id),
      );
    }
  }

  const database = new DatabaseSync(result.sqlite, { readOnly: true });
  try {
    const row = database.prepare('SELECT COUNT(*) AS count FROM profiles').get();
    assert.equal(row.count, 100);
    const ranking = database
      .prepare(
        'SELECT candidate_page_id FROM rankings WHERE query_page_id = ? AND mode = ? ORDER BY rank LIMIT 1',
      )
      .get('scp-008', 'breach');
    assert.equal(ranking.candidate_page_id, 'scp-3008');
    const metadata = database
      .prepare('SELECT key, value FROM metadata ORDER BY key')
      .all();
    assert.ok(metadata.some((entry) => entry.key === 'artifact_schema_version' && entry.value === '3'));
    assert.ok(metadata.some((entry) => entry.key === 'rule_version'));
  } finally {
    database.close();
  }
  const files = await readdir(directory);
  assert.equal(
    files.some((name) => /^(?:isorropia\.sqlite|isorropia-data\.json\.gz)\..+\.tmp$/.test(name)),
    false,
  );

  const secondDirectory = await mkdtemp(path.join(os.tmpdir(), 'isorropia-artifacts-repeat-'));
  t.after(() => rm(secondDirectory, { recursive: true, force: true }));
  const second = await buildArtifacts({ outputDirectory: secondDirectory });
  assert.deepEqual(await readFile(result.json), await readFile(second.json));
  const firstDatabase = new DatabaseSync(result.sqlite, { readOnly: true });
  const secondDatabase = new DatabaseSync(second.sqlite, { readOnly: true });
  try {
    for (const table of ['metadata', 'profiles', 'rules', 'edges', 'semantic_profiles', 'interactions', 'rankings']) {
      const firstCount = firstDatabase.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
      const secondCount = secondDatabase.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
      assert.equal(secondCount, firstCount);
    }
    assert.deepEqual(
      secondDatabase.prepare('SELECT key, value FROM metadata ORDER BY key').all(),
      firstDatabase.prepare('SELECT key, value FROM metadata ORDER BY key').all(),
    );
  } finally {
    firstDatabase.close();
    secondDatabase.close();
  }
});
