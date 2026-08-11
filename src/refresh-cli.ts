#!/usr/bin/env node
import { refreshData } from './refresh.js';

const args = new Set(process.argv.slice(2));
const allowed = new Set(['--bootstrap', '--check']);
for (const arg of args) {
  if (!allowed.has(arg)) {
    process.stderr.write(`Error: unknown option ${arg}\n`);
    process.exit(1);
  }
}

refreshData({
  bootstrap: args.has('--bootstrap'),
  check: args.has('--check'),
})
  .then((summary) => {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  });
