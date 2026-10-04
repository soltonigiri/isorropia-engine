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
  assert.match(lines[0], /^scp-002\t.+$/);
  assert.equal(lines[0].includes('cycle:'), false);
  assert.ok(lines.some((line) => line.startsWith('scp-008\t')));
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
  assert.equal(catalog[0].page_id, 'scp-002');
  assert.equal(catalog[0].url, 'https://scp-wiki.wikidot.com/scp-002');
  assert.ok(catalog[0].domains.includes('biology'));
  assert.equal(typeof catalog[0].counts.cycle, 'number');
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
    'scp-002',
    '--mode',
    'double-feature',
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

test('command help stays concise and documents only public options', async () => {
  const pair = await execFileAsync(process.execPath, ['dist/cli.js', 'pair', '--help']);
  const catalog = await execFileAsync(process.execPath, ['dist/cli.js', 'catalog', '--help']);
  assert.match(pair.stdout, /--with/);
  assert.match(pair.stdout, /--explain/);
  assert.match(catalog.stdout, /--mode/);
  assert.match(catalog.stdout, /--query/);
  assert.equal(pair.stdout.split('\n').length <= 5, true);
});

test('catalog search and mode filters compose', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    'dist/cli.js', 'catalog', '--query', 'scp-002', '--mode', 'double-feature', '--json',
  ]);
  const catalog = JSON.parse(stdout);
  assert.ok(catalog.length > 0);
  assert.ok(catalog.every((profile) => profile.counts['double-feature'] > 0));
});

test('pair inspection returns reviewed rejection reasons without failing', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    'dist/cli.js', 'pair', 'scp-008', '--mode', 'breach', '--with', 'scp-217', '--json',
  ]);
  const inspection = JSON.parse(stdout);
  assert.equal(inspection.status, 'rejected');
  assert.match(inspection.reason, /Parallel transmission/);
  assert.equal(inspection.disclaimer, 'Containment hypothesis — not canonical.');
});

test('pair inspection distinguishes accepted, weak, and unreviewed states', async () => {
  const commands = [
    ['scp-073', 'cycle', 'scp-076', 'accepted'],
    ['scp-002', 'cycle', 'scp-006', 'weak-signal'],
    ['scp-008', 'cycle', 'scp-015', 'unreviewed'],
  ];
  for (const [query, mode, candidate, expected] of commands) {
    const { stdout } = await execFileAsync(process.execPath, [
      'dist/cli.js', 'pair', query, '--mode', mode, '--with', candidate, '--json',
    ]);
    assert.equal(JSON.parse(stdout).status, expected);
  }
});

test('pair inspection rejects ranking-only options and explain-json duplication', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      'dist/cli.js', 'pair', 'scp-008', '--mode', 'cycle', '--with', 'scp-015', '--limit', '1',
    ]),
    /--with cannot be combined/,
  );
  await assert.rejects(
    execFileAsync(process.execPath, [
      'dist/cli.js', 'pair', 'scp-008', '--mode', 'breach', '--explain', '--json',
    ]),
    /--explain cannot be combined/,
  );
});

test('version reports package, database, and rule versions', async () => {
  const { stdout } = await execFileAsync(process.execPath, ['dist/cli.js', '--version']);
  assert.match(stdout, /^isorropia-engine 0\.1\.0$/m);
  assert.match(stdout, /^database [a-f0-9]{12}$/m);
  assert.match(stdout, /^rules [a-f0-9]{12}$/m);
});

test('empty results use one concise guidance line', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    'dist/cli.js', 'pair', 'scp-002', '--mode', 'cycle',
  ]);
  assert.equal((stdout.match(/No supported result/g) ?? []).length, 1);
  assert.match(stdout, /--setting rough/);
});
