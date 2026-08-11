import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertPublicDataDiffSafe,
  calculateDatabaseVersion,
  IsorropiaEngine,
  loadDataset,
  normalizeArticleSource,
  publishMaintenanceRun,
  rankExpansionCandidates,
  runMaintenance,
} from '../dist/index.js';

const sourceData = path.resolve('data');

test('expansion selection is deterministic and breaks equal scores by page id', async () => {
  const dataset = await loadDataset();
  const common = {
    content_file: 'content_series-10.json',
    created_at: '2020-01-01T00:00:00Z',
    creator: 'Example Author',
    history: [{}],
    rating: 100,
    series: 'series-10',
    tags: ['scp', 'artifact'],
  };
  const index = {
    'SCP-9101': {
      ...common,
      page_id: '9101',
      title: 'SCP-9101',
      url: 'https://scp-wiki.wikidot.com/scp-9101',
    },
    'SCP-9100': {
      ...common,
      page_id: '9100',
      title: 'SCP-9100',
      url: 'https://scp-wiki.wikidot.com/scp-9100',
    },
  };

  const ranked = rankExpansionCandidates({
    index,
    dataset,
    policy: dataset.selectionPolicy,
    now: new Date('2026-08-12T00:00:00Z'),
  });

  assert.deepEqual(ranked.map((item) => item.page_id), ['scp-9100', 'scp-9101']);
  assert.equal(ranked[0].selection_score, ranked[1].selection_score);
});

test('private paths and credentials are rejected from public data proposals', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'isorropia-sanitize-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    path.join(directory, 'semantics.json'),
    JSON.stringify({ note: '/home/example/private/run' }),
  );

  await assert.rejects(
    assertPublicDataDiffSafe(directory, ['data/semantics.json']),
    /Private material detected/,
  );
  await assert.rejects(
    assertPublicDataDiffSafe(directory, ['data/model-output.json']),
    /Non-allowlisted public path/,
  );
});

test('article normalization keeps prose and removes known page boilerplate', () => {
  const normalized = normalizeArticleSource([
    '[[module Rate]]',
    '[[/>]]',
    '[[include component:image-block',
    'name=image.jpg',
    ']]',
    '**Description:** Article-specific prose.',
    '[[div class="footer-wikiwalk-nav"]]',
    'previous | next',
    '[[/div]]',
    '[[include :scp-wiki:component:license-box]]',
    'License details',
  ].join('\n'));

  assert.equal(normalized, '**Description:** Article-specific prose.');
});

test('maintenance dry-run fills one missing semantic profile in a private proposal', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'isorropia-maintenance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDirectory = path.join(root, 'data');
  const privateDirectory = path.join(root, 'private');
  await cp(sourceData, dataDirectory, { recursive: true });
  const dataset = await loadDataset(dataDirectory);
  const index = sourceIndexFor(dataset);
  const fetchImpl = sourceFetch(index);
  const modelRunner = rejectingModelRunner();

  const summary = await runMaintenance({
    limit: 1,
    dryRun: true,
    dataDirectory,
    privateDirectory,
    fetchImpl,
    modelRunner,
    now: new Date('2026-08-12T00:00:00Z'),
  });

  assert.deepEqual(summary.analyzed, ['scp-002']);
  assert.deepEqual(summary.proposed, ['scp-002']);
  assert.ok(summary.rejected_interactions > 0);
  assert.equal(summary.rejected_interactions % 3, 0);
  const proposal = await loadDataset(summary.proposal_directory);
  const semantic = proposal.semantics.find((item) => item.page_id === 'scp-002');
  assert.deepEqual(semantic.reviewed_modes, ['cycle', 'breach', 'double-feature']);
  await assert.rejects(readFile(path.join(privateDirectory, 'state.json')), /ENOENT/);
});

test('publish uses an explicit data allowlist and creates only a draft PR', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'isorropia-publish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repositoryDirectory = path.join(root, 'repo');
  const dataDirectory = path.join(repositoryDirectory, 'data');
  const privateDirectory = path.join(root, 'private');
  await cp(sourceData, dataDirectory, { recursive: true });
  const dataset = await loadDataset(dataDirectory);
  const index = sourceIndexFor(dataset);
  const fetchImpl = sourceFetch(index);
  const run = await runMaintenance({
    limit: 1,
    dryRun: true,
    dataDirectory,
    privateDirectory,
    fetchImpl,
    modelRunner: rejectingModelRunner(),
    now: new Date('2026-08-12T00:00:00Z'),
  });
  const calls = [];
  let statusCalls = 0;
  const commandRunner = async (command, args, cwd) => {
    calls.push({ command, args, cwd });
    if (command === 'git' && args[0] === 'status') {
      statusCalls += 1;
      return statusCalls === 1
        ? { stdout: '', stderr: '' }
        : {
            stdout: [
              ' M data/interactions.json',
              ' M data/manifest.json',
              ' M data/semantics.json',
            ].join('\n'),
            stderr: '',
          };
    }
    if (command === 'gh') {
      return { stdout: 'https://github.com/example/repo/pull/1\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };

  const result = await publishMaintenanceRun({
    runId: run.run_id,
    repositoryDirectory,
    dataDirectory,
    privateDirectory,
    fetchImpl,
    commandRunner,
  });

  assert.equal(result.published, true);
  const add = calls.find((call) => call.command === 'git' && call.args[0] === 'add');
  assert.deepEqual(add.args.slice(0, 2), ['add', '--']);
  assert.equal(add.args.includes('-A'), false);
  const pr = calls.find((call) => call.command === 'gh');
  assert.equal(pr.args.includes('--draft'), true);
});

test('catalog expansion adds a profile only when an accepted interaction survives validation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'isorropia-expansion-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDirectory = path.join(root, 'data');
  const privateDirectory = path.join(root, 'private');
  await cp(sourceData, dataDirectory, { recursive: true });
  const initial = await loadDataset(dataDirectory);
  const semantics = [...initial.semantics];
  const semanticIds = new Set(semantics.map((item) => item.page_id));
  for (const profile of initial.profiles) {
    if (semanticIds.has(profile.page_id)) continue;
    const effect = profile.effects[0];
    semantics.push({
      page_id: profile.page_id,
      source_revision: profile.source_revision,
      claims: [{
        id: 'reviewed-metadata-effect',
        kind: 'effect',
        domain: effect.domain,
        operation: effect.operation,
        target: effect.target,
        outcomes: [effect.operation],
        preconditions: [effect.trigger],
        limitations: [...effect.constraints],
        evidence: [effect.evidence],
      }],
      reviewed_modes: ['cycle', 'breach', 'double-feature'],
    });
  }
  semantics.sort((left, right) => left.page_id.localeCompare(right.page_id));
  await writeFile(
    path.join(dataDirectory, 'semantics.json'),
    `${JSON.stringify(semantics, null, 2)}\n`,
  );
  const databaseVersion = calculateDatabaseVersion(
    initial.profiles,
    initial.edges,
    semantics,
    initial.interactions,
  );
  await writeFile(
    path.join(dataDirectory, 'manifest.json'),
    `${JSON.stringify({ ...initial.manifest, database_version: databaseVersion }, null, 2)}\n`,
  );
  const complete = await loadDataset(dataDirectory);
  const index = sourceIndexFor(complete);
  index['SCP-9100'] = {
    content_file: 'content_series-10.json',
    created_at: '2020-01-01T00:00:00Z',
    creator: 'Example Author',
    history: [{}, {}],
    page_id: '9100',
    rating: 500,
    references: [],
    series: 'series-10',
    tags: ['scp', 'medical', 'artifact'],
    title: 'SCP-9100',
    url: 'https://scp-wiki.wikidot.com/scp-9100',
  };
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.endsWith('/index.json')) return new Response(JSON.stringify(index));
    return new Response(JSON.stringify({
      'SCP-9100': {
        ...index['SCP-9100'],
        link: 'scp-9100',
        raw_source: '+ Description\nSCP-9100 restores damaged living tissue after direct contact.',
      },
    }));
  };
  const modelRunner = {
    async extract() {
      return [{
        page_id: 'scp-9100',
        source_revision: 1,
        claims: [{
          id: 'contact-tissue-restoration',
          kind: 'effect',
          domain: 'biology',
          operation: 'restore',
          target: 'living-tissue',
          outcomes: ['tissue-restoration'],
          preconditions: ['direct-contact'],
          limitations: ['living-tissue-only'],
          evidence: [{
            revision: 1,
            section: 'Description',
            locator: 'SCP-9100 restores damaged living tissue after direct contact.',
          }],
        }],
        reading: {
          themes: ['restoration'], forms: ['clinical-report'],
          structures: ['description'], tones: ['clinical'], motifs: ['healing'],
        },
      }];
    },
    async judge(candidates) {
      let accepted = false;
      return candidates.map((candidate) => {
        if (
          !accepted &&
          candidate.mode === 'double-feature' &&
          [candidate.left.page_id, candidate.right.page_id].includes('scp-006')
        ) {
          accepted = true;
          return {
            review_id: candidate.review_id,
            verdict: 'accepted',
            mechanism: 'Read two article-specific restoration mechanisms in sequence.',
            left_claim_refs: [candidate.left.claims[0].id],
            right_claim_refs: [candidate.right.claims[0].id],
            causal_chain: ['One article establishes restoration.', 'The other changes its mechanism.'],
            explanation: 'The contrast depends on the distinct delivery conditions in both articles.',
            assumption: 'The reading order is curatorial.',
            limitation: 'No cross-test is claimed.',
            rubric: {
              mode_fit: 'core', coherence: 'complete',
              specificity: 'article-specific', discovery_value: 'high',
            },
            support: 'B',
            reason: '',
          };
        }
        return rejectedReview(candidate.review_id);
      });
    },
  };

  const summary = await runMaintenance({
    limit: 1,
    dryRun: true,
    dataDirectory,
    privateDirectory,
    fetchImpl,
    modelRunner,
    now: new Date('2026-08-12T00:00:00Z'),
  });
  const proposal = await loadDataset(summary.proposal_directory);

  assert.deepEqual(summary.proposed, ['scp-9100']);
  assert.equal(proposal.profiles.length, 101);
  assert.equal(new IsorropiaEngine(proposal).coreCycle().cycle.length, 2);
  assert.equal(proposal.profiles.some((profile) => profile.page_id === 'scp-9100'), true);
  assert.equal(
    proposal.interactions.some((interaction) =>
      interaction.verdict === 'accepted' && interaction.pages.includes('scp-9100'),
    ),
    true,
  );

  const rejectedSummary = await runMaintenance({
    limit: 1,
    dryRun: true,
    dataDirectory,
    privateDirectory: path.join(root, 'rejected-private'),
    fetchImpl,
    modelRunner: {
      extract: modelRunner.extract,
      async judge(candidates) {
        return candidates.map((candidate) => rejectedReview(candidate.review_id));
      },
    },
    now: new Date('2026-08-12T00:01:00Z'),
  });
  const rejectedProposal = await loadDataset(rejectedSummary.proposal_directory);
  assert.deepEqual(rejectedSummary.proposed, []);
  assert.deepEqual(rejectedSummary.deferred, ['scp-9100']);
  assert.equal(rejectedProposal.profiles.length, 100);
});

function sourceIndexFor(dataset) {
  return Object.fromEntries(dataset.profiles.map((profile) => [
    profile.page_id.toUpperCase(),
    {
      content_file: 'content_series-1.json',
      created_at: '2020-01-01T00:00:00Z',
      creator: profile.authors[0] ?? 'Example Author',
      history: Array.from({ length: profile.source_revision + 1 }, () => ({})),
      page_id: profile.wikidot_page_id,
      rating: 100,
      references: [],
      series: profile.series,
      tags: profile.tags.includes('scp') ? profile.tags : [...profile.tags, 'scp'],
      title: profile.title,
      url: profile.url,
    },
  ]));
}

function sourceFetch(index) {
  return async (input) => {
    const url = String(input);
    if (url.endsWith('/index.json')) {
      return new Response(JSON.stringify(index), { status: 200 });
    }
    return new Response(JSON.stringify({
      'SCP-002': {
        history: index['SCP-002'].history,
        link: 'scp-002',
        url: 'https://scp-wiki.wikidot.com/scp-002',
        raw_source: '+ Description\nSCP-002 converts introduced living humans into biological furniture.',
      },
    }), { status: 200 });
  };
}

function rejectingModelRunner() {
  return {
    async extract(chunks) {
      return chunks.map((chunk) => ({
        page_id: chunk.page_id,
        source_revision: chunk.source_revision,
        claims: [{
          id: 'human-to-furniture-conversion',
          kind: 'effect',
          domain: 'biology',
          operation: 'transform',
          target: 'human',
          outcomes: ['biological-furniture'],
          preconditions: ['human-introduced'],
          limitations: ['requires-living-human'],
          evidence: [{
            revision: chunk.source_revision,
            section: 'Description',
            locator: 'SCP-002 converts introduced living humans into biological furniture.',
          }],
        }],
        reading: {
          themes: ['consumption'],
          forms: ['clinical-report'],
          structures: ['containment-description'],
          tones: ['horror'],
          motifs: ['furniture'],
        },
      }));
    },
    async judge(candidates) {
      return candidates.map((candidate) => rejectedReview(candidate.review_id));
    },
  };
}

function rejectedReview(reviewId) {
  return {
    review_id: reviewId,
    verdict: 'rejected',
    mechanism: '',
    left_claim_refs: [],
    right_claim_refs: [],
    causal_chain: [],
    explanation: '',
    assumption: '',
    limitation: '',
    rubric: {
      mode_fit: 'partial',
      coherence: 'thematic',
      specificity: 'generic',
      discovery_value: 'low',
    },
    support: 'C',
    reason: 'No article-specific interaction is supported.',
  };
}
