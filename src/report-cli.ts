#!/usr/bin/env node
import { loadDataset } from './data.js';
import { buildCoverageReport, formatCoverageReport } from './report.js';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--json')) {
  process.stderr.write('Usage: npm run report -- [--json]\n');
  process.exitCode = 1;
} else {
  const report = buildCoverageReport(await loadDataset());
  process.stdout.write(args.includes('--json')
    ? `${JSON.stringify(report, null, 2)}\n`
    : formatCoverageReport(report));
}
