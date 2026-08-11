import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { refreshData } from '../dist/index.js';

test('refresh writes a candidate without overwriting curated data', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'isorropia-refresh-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'profiles'));
  await mkdir(path.join(directory, 'candidates'));
  await writeJson(path.join(directory, 'curation.json'), [
    { page_id: 'scp-500', focus_tags: ['medical'] },
  ]);
  await writeJson(path.join(directory, 'tag-effects.json'), {
    medical: {
      domain: 'biology',
      operation: 'restore',
      target: 'organism',
      trigger: 'administration',
      persistence: 'persistent',
    },
  });
  const curated = {
    page_id: 'scp-500',
    scp_number: 500,
    wikidot_page_id: '1',
    title: 'SCP-500',
    url: 'https://scp-wiki.wikidot.com/scp-500',
    authors: ['Author'],
    language: 'en',
    source_revision: 1,
    tags: ['medical', 'scp'],
    themes: ['medical'],
    effects: [
      {
        domain: 'biology',
        operation: 'restore',
        target: 'organism',
        trigger: 'administration',
        persistence: 'persistent',
        constraints: ['maintainer-value'],
        evidence: { revision: 1, section: 'metadata.tags', locator: 'tag:medical' },
      },
    ],
    curated: true,
  };
  const profilePath = path.join(directory, 'profiles', 'scp-500.json');
  await writeJson(profilePath, curated);
  const before = await readFile(profilePath, 'utf8');

  const summary = await refreshData({
    dataDirectory: directory,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          'SCP-500': {
            creator: 'Author',
            history: [{}, {}, {}],
            link: 'scp-500',
            page_id: '1',
            references: [],
            scp_number: 500,
            series: 'series-1',
            tags: ['medical', 'scp'],
            title: 'SCP-500',
            url: 'https://scp-wiki.wikidot.com/scp-500',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  });

  assert.deepEqual(summary.changed, ['scp-500']);
  assert.equal(await readFile(profilePath, 'utf8'), before);
  const candidate = JSON.parse(
    await readFile(path.join(directory, 'candidates', 'scp-500.json'), 'utf8'),
  );
  assert.equal(candidate.curated, false);
  assert.equal(candidate.source_revision, 2);
  assert.deepEqual(candidate.effects[0].constraints, []);
});

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
