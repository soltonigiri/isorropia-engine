import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { buildArtifacts } from '../dist/index.js';

test('release artifacts contain the validated 100-profile dataset', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'isorropia-artifacts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await buildArtifacts({ outputDirectory: directory });
  assert.equal(result.profile_count, 100);

  const json = JSON.parse(
    gunzipSync(await readFile(result.json)).toString('utf8'),
  );
  assert.equal(json.profiles.length, 100);
  assert.equal(json.manifest.attributions.length, 100);

  const database = new DatabaseSync(result.sqlite, { readOnly: true });
  try {
    const row = database.prepare('SELECT COUNT(*) AS count FROM profiles').get();
    assert.equal(row.count, 100);
  } finally {
    database.close();
  }
});
