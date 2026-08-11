import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { synchronizeAttribution } from '../dist/index.js';

test('official attribution metadata overrides creator fallback', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'isorropia-attribution-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'profiles'));
  const profile = {
    page_id: 'scp-055',
    scp_number: 55,
    wikidot_page_id: '1955017',
    title: 'SCP-055',
    url: 'https://scp-wiki.wikidot.com/scp-055',
    authors: ['creator-fallback'],
    language: 'en',
    source_revision: 1,
    tags: ['scp'],
    themes: ['antimemetic'],
    effects: [],
    curated: true,
  };
  await writeFile(
    path.join(directory, 'profiles', 'scp-055.json'),
    `${JSON.stringify(profile, null, 2)}\n`,
  );
  await writeFile(
    path.join(directory, 'manifest.json'),
    `${JSON.stringify({
      database_version: 'test',
      generated_at: '2026-08-11T00:00:00.000Z',
      source: 'test',
      profile_count: 1,
      attributions: [
        {
          page_id: 'scp-055',
          title: 'SCP-055',
          url: profile.url,
          authors: profile.authors,
          revision: 1,
          license: 'CC BY-SA 3.0',
        },
      ],
    }, null, 2)}\n`,
  );
  const html = `
    <table><tbody>
      <tr><td>scp-055</td><td>qntm</td><td>author</td><td></td></tr>
      <tr><td>scp-055</td><td>CptBellman</td><td>Author</td><td></td></tr>
      <tr><td>scp-055</td><td>Someone Else</td><td>rewrite</td><td></td></tr>
    </tbody></table>`;
  const summary = await synchronizeAttribution({
    apply: true,
    dataDirectory: directory,
    fetchImpl: async () => new Response(html),
  });
  assert.deepEqual(summary, {
    checked: 1,
    changed: ['scp-055'],
    applied: true,
  });
  const updatedProfile = JSON.parse(
    await readFile(path.join(directory, 'profiles', 'scp-055.json'), 'utf8'),
  );
  const updatedManifest = JSON.parse(
    await readFile(path.join(directory, 'manifest.json'), 'utf8'),
  );
  assert.deepEqual(updatedProfile.authors, ['CptBellman', 'qntm']);
  assert.deepEqual(updatedManifest.attributions[0].authors, [
    'CptBellman',
    'qntm',
  ]);
});
