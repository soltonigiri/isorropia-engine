import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeWindowsTaskDefinition } from '../dist/index.js';

test('Windows task definition is importable configuration and is not registered', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'isorropia-task-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await writeWindowsTaskDefinition({
    repositoryDirectory: '/srv/isorropia',
    windowsUser: 'EXAMPLE\\maintainer',
    privateDirectory: root,
    now: new Date('2026-08-12T00:00:00Z'),
  });
  const xml = await readFile(result.xml_path, 'utf8');
  const config = JSON.parse(await readFile(result.config_path, 'utf8'));

  assert.match(xml, /<Monday \/>/);
  assert.match(xml, /T12:00:00/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /<StartWhenAvailable>true<\/StartWhenAvailable>/);
  assert.match(xml, /<ExecutionTimeLimit>PT8H<\/ExecutionTimeLimit>/);
  assert.equal(config.registration, 'not-registered');
});
