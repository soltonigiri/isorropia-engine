import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { buildArtifacts } from '../dist/index.js';

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
  assert.equal(json.rankings['scp-008'].breach[0].page_id, 'scp-610');

  const database = new DatabaseSync(result.sqlite, { readOnly: true });
  try {
    const row = database.prepare('SELECT COUNT(*) AS count FROM profiles').get();
    assert.equal(row.count, 100);
    const ranking = database
      .prepare(
        'SELECT candidate_page_id FROM rankings WHERE query_page_id = ? AND mode = ? ORDER BY rank LIMIT 1',
      )
      .get('scp-008', 'breach');
    assert.equal(ranking.candidate_page_id, 'scp-610');
  } finally {
    database.close();
  }
  const files = await readdir(directory);
  assert.equal(
    files.some((name) => /^(?:isorropia\.sqlite|isorropia-data\.json\.gz)\..+\.tmp$/.test(name)),
    false,
  );
});
