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
  assert.match(stdout, /isorropia validate/);
  assert.equal(stdout.includes('judgement'), false);
  assert.equal(stdout.includes('roster'), false);
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
