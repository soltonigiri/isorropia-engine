#!/usr/bin/env node
import { synchronizeAttribution } from './attribution.js';

const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (arg !== '--apply') {
    process.stderr.write(`Error: unknown option ${arg}\n`);
    process.exit(1);
  }
}

synchronizeAttribution({ apply: args.has('--apply') })
  .then((summary) => {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  });
