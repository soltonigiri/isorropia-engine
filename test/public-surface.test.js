import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const rootFiles = [
  'README.md', 'README.ja.md', 'MVP仕様.md',
  'DATASET.md', 'CONTRIBUTING.md',
];
const forbidden = [
  new RegExp(['easter', 'egg'].join('[ -]?'), 'i'),
  new RegExp(['イースター', 'エッグ'].join('')),
  /●●\|●●●●●\|●●\|●/,
];

test('public documentation and templates do not disclose implementation-only behavior', async () => {
  const files = [
    ...rootFiles,
    ...await filesUnder('docs'),
    ...await filesUnder('.github'),
  ];
  for (const file of files) {
    for (const pattern of forbidden) {
      assert.equal(pattern.test(file), false, `forbidden public filename: ${file}`);
      assert.equal(pattern.test(await readFile(file, 'utf8')), false, `forbidden public text: ${file}`);
    }
  }
});

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const value = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(value));
    else files.push(value);
  }
  return files.sort();
}
