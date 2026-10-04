import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CodexQualitativeModelRunner,
  verifyAcceptedProposals,
} from '../dist/model-runner.js';

test('semantic extraction receives the configured finite ontology', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'isorropia-model-runner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'fake-codex.mjs');
  await writeFile(executable, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'login') {
  process.stdout.write('Logged in using ChatGPT\\n');
  process.exit(0);
}
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const option = (name) => args[args.indexOf(name) + 1];
const schema = JSON.parse(readFileSync(option('--output-schema'), 'utf8'));
const claim = schema.properties.profiles.items.properties.claims.items.properties;
const expected = {
  role: 'custom-role',
  operation_class: 'custom-operation',
  domain_class: 'custom-domain',
  affected_state: 'custom-state',
  direction: 'custom-direction',
};
for (const [key, value] of Object.entries(expected)) {
  if (!claim[key].enum.includes(value) || !prompt.includes(value)) process.exit(2);
}
writeFileSync(option('--output-last-message'), JSON.stringify({ profiles: [{
  chunk_id: '1/1',
  page_id: 'scp-001',
  source_revision: 1,
  claims: [{
    id: 'specific-claim', kind: 'effect', domain: 'source domain',
    operation: 'source operation', subject: 'subject', target: 'target',
    vector: '', trigger: '', scope: '', persistence: '',
    outcomes: ['specific outcome'], preconditions: [], limitations: [],
    evidence: [{ revision: 1, section: 'Description', locator: 'Exact source sentence.' }],
    ...expected, raw_operation: 'source operation', raw_domain: 'source domain',
    chunk_ids: ['1/1'],
  }],
  reading: { themes: [], forms: [], structures: [], tones: [], motifs: [], moves: [] },
}] }));
`);
  await chmod(executable, 0o755);
  const ontology = {
    version: 1,
    claim_roles: ['custom-role'],
    directions: ['custom-direction'],
    reading_moves: ['premise'],
    domains: { 'custom-domain': [] },
    operations: { 'custom-operation': [] },
    affected_states: { 'custom-state': [] },
  };
  const runner = new CodexQualitativeModelRunner(executable);

  const [profile] = await runner.extract([{
    page_id: 'scp-001',
    source_revision: 1,
    title: 'SCP-001',
    chunk_id: '1/1',
    source: 'Exact source sentence.',
  }], directory, ontology);

  assert.equal(profile.claims[0].role, 'custom-role');
  assert.equal(profile.claims[0].direction, 'custom-direction');
});

test('independent verification is limited to proposed acceptances', async () => {
  const candidates = [
    { review_id: 'cycle:scp-001:scp-002' },
    { review_id: 'cycle:scp-001:scp-003' },
    { review_id: 'cycle:scp-001:scp-004' },
  ];
  const proposals = candidates.map((candidate, index) => ({
    review_id: candidate.review_id,
    verdict: index === 1 ? 'accepted' : 'rejected',
  }));
  let verifiedCandidates;
  let verifiedProposals;
  const runner = {
    async verify(receivedCandidates, receivedProposals) {
      verifiedCandidates = receivedCandidates;
      verifiedProposals = receivedProposals;
      return receivedProposals.map((proposal) => ({
        ...proposal,
        verdict: 'rejected',
        reason: 'The independent check found a decisive objection.',
      }));
    },
  };

  const result = await verifyAcceptedProposals(runner, candidates, proposals, '/unused');

  assert.deepEqual(verifiedCandidates.map((candidate) => candidate.review_id), [
    'cycle:scp-001:scp-003',
  ]);
  assert.deepEqual(verifiedProposals.map((proposal) => proposal.review_id), [
    'cycle:scp-001:scp-003',
  ]);
  assert.deepEqual(result.map((review) => review.verdict), [
    'rejected', 'rejected', 'rejected',
  ]);
});

test('verification is skipped when the proposer rejects every candidate', async () => {
  let verifyCalls = 0;
  const proposals = [{ review_id: 'breach:scp-001:scp-002', verdict: 'rejected' }];
  const result = await verifyAcceptedProposals({
    async verify() {
      verifyCalls += 1;
      return [];
    },
  }, [{ review_id: proposals[0].review_id }], proposals, '/unused');

  assert.equal(verifyCalls, 0);
  assert.equal(result, proposals);
});

test('incomplete proposals and duplicate verifier results cannot be accepted', async () => {
  const candidates = [{ review_id: 'cycle:scp-001:scp-002' }];
  const proposals = [{ ...candidates[0], verdict: 'accepted' }];
  const runner = { async verify() { return [proposals[0], proposals[0]]; } };

  await assert.rejects(
    verifyAcceptedProposals(runner, candidates, [], '/unused'),
    /omitted or added an interaction proposal/,
  );
  await assert.rejects(
    verifyAcceptedProposals(runner, candidates, proposals, '/unused'),
    /omitted or duplicated an accepted interaction review/,
  );
});
