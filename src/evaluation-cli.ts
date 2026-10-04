#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateQualitativeFixtures } from './evaluation.js';

const args = process.argv.slice(2);
if (args.length > 1) {
  throw new Error('Usage: npm run evaluate [-- fixture-path]');
}
const defaultFixture = fileURLToPath(
  new URL('../test/fixtures/qualitative-cases.json', import.meta.url),
);
const result = await evaluateQualitativeFixtures({
  fixturePath: path.resolve(args[0] ?? defaultFixture),
});
process.stdout.write(`${JSON.stringify({
  ...result.report,
  results: undefined,
  output_directory: result.output_directory,
}, null, 2)}\n`);
