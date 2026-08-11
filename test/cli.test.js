import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('CLI help exposes only the documented command surface', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    'dist/cli.js',
    '--help',
  ]);
  assert.match(stdout, /isorropia pair/);
  assert.match(stdout, /isorropia catalog/);
  assert.match(stdout, /isorropia validate/);
  assert.equal(stdout.includes('judgement'), false);
  assert.equal(stdout.includes('roster'), false);
});

test('CLI catalog lists the included profiles in numeric order', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    'dist/cli.js',
    'catalog',
  ]);
  const lines = stdout.trim().split('\n');
  assert.equal(lines.length, 100);
  assert.equal(lines[0], 'scp-002');
  assert.ok(lines.includes('scp-008'));
  const numbers = lines.map((line) => Number(/^scp-(\d+)/.exec(line)?.[1]));
  assert.deepEqual(numbers, [...numbers].sort((left, right) => left - right));
});

test('CLI catalog emits stable profile metadata as JSON', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    'dist/cli.js',
    'catalog',
    '--json',
  ]);
  const catalog = JSON.parse(stdout);
  assert.equal(catalog.length, 100);
  assert.deepEqual(catalog[0], {
    page_id: 'scp-002',
    title: 'SCP-002',
    url: 'https://scp-wiki.wikidot.com/scp-002',
  });
});

test('CLI points unknown profiles to the catalog', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      'dist/cli.js',
      'pair',
      'scp-99999',
      '--mode',
      'cycle',
    ]),
    /not in the curated catalog; run "isorropia catalog"/,
  );
});

test('CLI emits structured JSON without decorative SCP-2521 output', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    'dist/cli.js',
    'pair',
    'scp-2521',
    '--mode',
    'double-feature',
    '--limit',
    '1',
    '--json',
  ]);
  const output = JSON.parse(stdout);
  assert.equal(output.query.page_id, 'scp-2521');
  assert.equal(stdout.includes('●●|●●●●●|●●|●'), false);
  assert.equal(output.disclaimer, 'Containment hypothesis — not canonical.');
});

test('CLI keeps plain human output when stdout is not a terminal', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    'dist/cli.js',
    'pair',
    'scp-3984',
    '--mode',
    'cycle',
    '--limit',
    '1',
  ]);

  assert.equal(stdout.includes('╭'), false);
  assert.match(stdout, /score=100 confidence=0\.90/);
});

test('CLI rejects unsupported modes', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      'dist/cli.js',
      'pair',
      'scp-055',
      '--mode',
      'unknown',
    ]),
    /--mode must be one of/,
  );
});

test('CLI rejects unknown options instead of silently using defaults', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      'dist/cli.js',
      'pair',
      'scp-008',
      '--mode',
      'breach',
      '--limti',
      '1',
    ]),
    /Unknown option: --limti/,
  );
});
