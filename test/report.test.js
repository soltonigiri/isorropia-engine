import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCoverageReport,
  formatCoverageReport,
  loadDataset,
} from '../dist/index.js';

test('coverage report exposes review, concentration, diversity, and attribution metrics', async () => {
  const report = buildCoverageReport(await loadDataset());
  assert.equal(report.profiles, 100);
  assert.equal(report.semantics, 100);
  assert.equal(
    report.source_coverage.complete + report.source_coverage.partial,
    report.semantics,
  );
  assert.equal(
    report.accepted_with_proof,
    Object.values(report.interactions).reduce((sum, mode) => sum + mode.accepted, 0),
  );
  assert.equal(
    report.interactions_with_provenance,
    Object.values(report.interactions).reduce(
      (sum, mode) => sum + mode.accepted + mode.rejected,
      0,
    ),
  );
  assert.ok(Object.keys(report.domains).length > 1);
  assert.match(formatCoverageReport(report), /Source coverage: complete \d+, partial \d+/);
});
