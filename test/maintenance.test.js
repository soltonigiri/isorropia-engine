import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertPublicDataDiffSafe,
  analysisPolicyDigests,
  applyMaintenanceRun,
  calculateDatabaseVersion,
  createMaintenancePlan,
  IsorropiaEngine,
  loadDataset,
  normalizeArticleSource,
  prepareMaintenanceCheckout,
  publishMaintenanceRun,
  rankExpansionCandidates,
  runMaintenance,
  validateDataset,
  writeLastRunStatus,
} from '../dist/index.js';
import { loadArticle, normalizeWikidotDisplayText } from '../dist/article-source.js';
import { retainSourceGroundedContent } from '../dist/maintenance.js';

const sourceData = path.resolve('data');

async function removeSemanticProfiles(dataDirectory, pageIds) {
  const dataset = await loadDataset(dataDirectory);
  const removed = new Set(pageIds);
  const semantics = dataset.semantics.filter((item) => !removed.has(item.page_id));
  const interactions = dataset.interactions.filter((item) =>
    item.pages.every((pageId) => !removed.has(pageId)),
  );
  const golden = dataset.golden.filter((item) =>
    !removed.has(item.left) && (!item.right || !removed.has(item.right)),
  );
  const manifest = {
    ...dataset.manifest,
    database_version: calculateDatabaseVersion({
      profiles: dataset.profiles,
      edges: dataset.edges,
      semantics,
      interactions,
      semanticOntology: dataset.semanticOntology,
      analysisPolicy: dataset.analysisPolicy,
    }),
  };
  await Promise.all([
    writeFile(
      path.join(dataDirectory, 'semantics.json'),
      `${JSON.stringify(semantics, null, 2)}\n`,
    ),
    writeFile(
      path.join(dataDirectory, 'interactions.json'),
      `${JSON.stringify(interactions, null, 2)}\n`,
    ),
    writeFile(
      path.join(dataDirectory, 'golden-pairs.json'),
      `${JSON.stringify(golden, null, 2)}\n`,
    ),
    writeFile(
      path.join(dataDirectory, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    ),
  ]);
}

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

test('semantic policy migration is completed before catalog expansion', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'isorropia-policy-plan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDirectory = path.join(root, 'data');
  const privateDirectory = path.join(root, 'private');
  await cp(sourceData, dataDirectory, { recursive: true });
  const dataset = await loadDataset(dataDirectory);
  const stalePage = dataset.semantics[0].page_id;
  const semantics = dataset.semantics.map((semantic) => semantic.page_id === stalePage
    ? { ...semantic, semantic_policy_digest: 'historical-semantic-policy' }
    : semantic);
  await writeFile(
    path.join(dataDirectory, 'semantics.json'),
    `${JSON.stringify(semantics, null, 2)}\n`,
  );
  const index = sourceIndexFor(dataset);
  const plan = await createMaintenancePlan({
    limit: 2,
    dataDirectory,
    privateDirectory,
    fetchImpl: async () => new Response(JSON.stringify(index), { status: 200 }),
    now: new Date('2026-08-12T00:00:00Z'),
  });

  assert.equal(plan.bootstrap_complete, false);
  assert.deepEqual(plan.entries.map((entry) => entry.page_id), [stalePage]);
  assert.equal(plan.entries.every((entry) => entry.reason === 'semantic-policy-changed'), true);
});

test('a review policy change rechecks only existing stale interactions', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'isorropia-review-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDirectory = path.join(root, 'data');
  const privateDirectory = path.join(root, 'private');
  await cp(sourceData, dataDirectory, { recursive: true });
  const dataset = await loadDataset(dataDirectory);
  const digests = analysisPolicyDigests({
    policy: dataset.analysisPolicy,
    ontology: dataset.semanticOntology,
  });
  const target = dataset.interactions.find((interaction) =>
    interaction.mode === 'breach' && interaction.verdict === 'accepted');
  assert.ok(target);
  const semantics = dataset.semantics.map((semantic) => ({
    ...semantic,
    semantic_policy_digest: digests.semantic,
  }));
  const interactions = dataset.interactions.map((interaction) => ({
    ...interaction,
    review_policy_digest: interaction.id === target.id
      ? 'stale-review-policy'
      : digests.review_modes[interaction.mode],
  }));
  const manifest = {
    ...dataset.manifest,
    database_version: calculateDatabaseVersion({
      profiles: dataset.profiles,
      edges: dataset.edges,
      semantics,
      interactions,
      semanticOntology: dataset.semanticOntology,
      analysisPolicy: dataset.analysisPolicy,
    }),
  };
  await Promise.all([
    writeFile(path.join(dataDirectory, 'semantics.json'), `${JSON.stringify(semantics, null, 2)}\n`),
    writeFile(path.join(dataDirectory, 'interactions.json'), `${JSON.stringify(interactions, null, 2)}\n`),
    writeFile(path.join(dataDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`),
  ]);
  const index = sourceIndexFor(dataset);
  const plan = await createMaintenancePlan({
    limit: 100,
    dataDirectory,
    privateDirectory,
    fetchImpl: async () => new Response(JSON.stringify(index), { status: 200 }),
    now: new Date('2026-08-13T00:00:00Z'),
  });
  assert.deepEqual(plan.entries.map((entry) => [entry.page_id, entry.reason]), [
    [target.pages[0], 'review-policy-changed'],
  ]);
  const proposedGroups = [];
  let extractionCalls = 0;
  let verificationCalls = 0;
  const summary = await runMaintenance({
    limit: 100,
    dryRun: true,
    dataDirectory,
    privateDirectory,
    fetchImpl: async () => new Response(JSON.stringify(index), { status: 200 }),
    modelRunner: {
      async extract() {
        extractionCalls += 1;
        return [];
      },
      async propose(candidates) {
        proposedGroups.push(candidates.map((candidate) => candidate.review_id));
        return candidates.map((candidate) => rejectedReview(candidate.review_id));
      },
      async verify() {
        verificationCalls += 1;
        return [];
      },
    },
    now: new Date('2026-08-13T00:00:00Z'),
  });

  assert.deepEqual(summary.analyzed, []);
  assert.deepEqual(summary.proposed, []);
  assert.equal(extractionCalls, 0);
  assert.equal(verificationCalls, 0);
  assert.deepEqual(proposedGroups.flat(), [
    `${target.mode}:${target.pages.join(':')}`,
  ]);
  assert.equal(summary.rejected_interactions, 1);
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

  assert.equal(normalized, 'Description: Article-specific prose.');
});

test('visible Wikidot link labels remain exact evidence text', () => {
  assert.equal(
    normalizeWikidotDisplayText(
      '[[[SCP-500]]] can //completely// cure [[[scp-008 | the disease]]].',
    ),
    'SCP-500 can completely cure the disease.',
  );
});

test('unsupported generated claims are removed without discarding grounded claims', () => {
  const article = {
    entry: { page_id: 'scp-001', source_revision: 1, title: 'SCP-001' },
    normalized_source: 'A supported article-specific claim appears here.',
  };
  const semantic = {
    page_id: 'scp-001',
    source_revision: 1,
    claims: [
      {
        id: 'grounded',
        kind: 'effect',
        domain: 'information',
        operation: 'preserve',
        outcomes: ['preserved'],
        preconditions: [],
        limitations: [],
        evidence: [{
          revision: 1,
          section: 'Description',
          locator: 'A supported article-specific claim appears here.',
        }],
      },
      {
        id: 'joined-dialogue',
        kind: 'effect',
        domain: 'information',
        operation: 'alter',
        outcomes: ['altered'],
        preconditions: [],
        limitations: [],
        evidence: [{
          revision: 1,
          section: 'Dialogue',
          locator: 'A supported claim joined to words absent from the article.',
        }],
      },
    ],
  };

  const result = retainSourceGroundedContent(semantic, article);

  assert.deepEqual(result.claims.map((claim) => claim.id), ['grounded']);
});

test('known presentation includes do not make article coverage partial', async (t) => {
  const privateDirectory = await mkdtemp(path.join(os.tmpdir(), 'isorropia-source-coverage-'));
  t.after(() => rm(privateDirectory, { recursive: true, force: true }));
  const source = {
    content_file: 'content_series-1.json',
    history: Array.from({ length: 3 }, () => ({})),
    page_id: '2',
    title: 'SCP-002',
    url: 'https://scp-wiki.wikidot.com/scp-002',
  };
  const article = await loadArticle({
    entry: { page_id: 'scp-002', source_revision: 2, title: 'SCP-002' },
    source,
    privateDirectory,
    sourceLimits: {
      maximum_depth: 4,
      maximum_segments: 32,
      maximum_characters: 2_000_000,
    },
    fetchImpl: async () => new Response(JSON.stringify({
      'SCP-002': {
        ...source,
        link: 'scp-002',
        raw_source: [
          '[[include <a href="/theme:black-highlighter-theme">theme:black-highlighter-theme</a>]]',
          '[[include <a href="/component:adult-content-warning">component:adult-content-warning</a>]]',
          '[[include <a href="/component:info-ayers">component:info-ayers</a>]]',
          '[[include <a href="/component:object-warning-box-source">component:object-warning-box-source</a>]]',
          '[[include <a href="/component:anomaly-class-bar-source">component:anomaly-class-bar-source</a>]]',
          '[[include <a href="/component:author-label-source">component:author-label-source</a> start=--]]',
          '[[include <a href="/component:customizable-acs">component:customizable-acs</a>]]',
          '[[include <a href="/component:preview">component:preview</a>]]',
          '[[include <a href="/component:earthworm">component:earthworm</a>]]',
          '[[include <a href="/component:wikimodule">component:wikimodule</a> |ratings=--]]',
          '[[include <a href="/info:start">info:start</a>]]',
          '[[include <a href="/component:djk">component:djk</a>]]',
          '[[include <a href="/component:image-block">component:image-block</a> name=image.jpg]]',
          '[[module ListPages range="."]]\n%%title%% -- %%content{4}%%\n[[/module]]',
          '+ Description',
          'Article-specific prose establishes the anomalous mechanism.',
          '[[include <a href="/info:end">info:end</a>]]',
          '[[include <a href="/component:license-box">component:license-box</a>]]',
        ].join('\n'),
      },
    })),
  });

  assert.equal(article.coverage, 'complete');
  assert.deepEqual(article.unresolved_features, []);
});

test('hidden style frames do not make rendered article coverage partial', async (t) => {
  const privateDirectory = await mkdtemp(path.join(os.tmpdir(), 'isorropia-style-frame-'));
  t.after(() => rm(privateDirectory, { recursive: true, force: true }));
  const source = {
    content_file: 'content_series-9.json',
    history: Array.from({ length: 3 }, () => ({})),
    page_id: '8999',
    title: 'SCP-8999',
    url: 'https://scp-wiki.wikidot.com/scp-8999',
  };
  const article = await loadArticle({
    entry: { page_id: 'scp-8999', source_revision: 2, title: 'SCP-8999' },
    source,
    privateDirectory,
    sourceLimits: {
      maximum_depth: 4,
      maximum_segments: 32,
      maximum_characters: 2_000_000,
    },
    fetchImpl: async () => new Response(JSON.stringify({
      'SCP-8999': {
        ...source,
        link: 'scp-8999',
        raw_source: '[[module ListPages category="fragment"]]\n%%content%%\n[[/module]]',
        raw_content: [
          '<div id="page-content"><p>Rendered article prose.</p>',
          '<iframe src="//interwiki.scpwiki.com/styleFrame.html?priority=1" style="display: none"></iframe>',
          '<iframe src="//interwiki.scpwiki.com/interwikiFrame.html?lang=en" class="scpnet-interwiki-frame"></iframe>',
          '</div>',
        ].join(''),
      },
    })),
  });

  assert.deepEqual(article.unresolved_features, ['dynamic-list']);
});

test('an image-only article keeps source evidence with partial coverage', async (t) => {
  const privateDirectory = await mkdtemp(path.join(os.tmpdir(), 'isorropia-visual-source-'));
  t.after(() => rm(privateDirectory, { recursive: true, force: true }));
  const source = {
    content_file: 'content_series-3.json',
    history: Array.from({ length: 3 }, () => ({})),
    page_id: '2521',
    title: 'SCP-2521',
    url: 'https://scp-wiki.wikidot.com/scp-2521',
  };
  const article = await loadArticle({
    entry: { page_id: 'scp-2521', source_revision: 2, title: 'SCP-2521' },
    source,
    privateDirectory,
    sourceLimits: {
      maximum_depth: 4,
      maximum_segments: 32,
      maximum_characters: 2_000_000,
    },
    fetchImpl: async () => new Response(JSON.stringify({
      'SCP-2521': {
        ...source,
        link: 'scp-2521',
        raw_source: [
          '[[=image lock2.png style="width:110px;"]] ',
          '[[=image documents4.png style="width:370px;"]] ',
        ].join('\n'),
        raw_content: '<div id="page-content"><img alt="lock2.png"></div>',
      },
    })),
  });

  assert.equal(article.coverage, 'partial');
  assert.deepEqual(article.unresolved_features, ['visual-primary']);
  assert.match(article.normalized_source, /lock2\.png/);
});

test('an unavailable rendered segment is recorded as partial coverage', async (t) => {
  const privateDirectory = await mkdtemp(path.join(os.tmpdir(), 'isorropia-source-partial-'));
  t.after(() => rm(privateDirectory, { recursive: true, force: true }));
  const source = {
    content_file: 'content_series-1.json',
    history: Array.from({ length: 3 }, () => ({})),
    page_id: '2',
    title: 'SCP-002',
    url: 'https://scp-wiki.wikidot.com/scp-002',
  };
  let renderedRequests = 0;
  const article = await loadArticle({
    entry: { page_id: 'scp-002', source_revision: 2, title: 'SCP-002' },
    source,
    privateDirectory,
    sourceLimits: {
      maximum_depth: 4,
      maximum_segments: 32,
      maximum_characters: 2_000_000,
    },
    fetchImpl: async (input) => {
      if (String(input).endsWith('/scp-002/offset/1')) {
        renderedRequests += 1;
        return new Response('', { status: 503 });
      }
      return new Response(JSON.stringify({
        'SCP-002': {
          ...source,
          link: 'scp-002',
          raw_source: '[[module ListPages]]\n%%content%%\n[[/module]]',
          raw_content: [
            '<div id="page-content"><p>Article-specific rendered introduction.</p>',
            '<a href="/scp-002/offset/1">Next</a></div>',
          ].join(''),
        },
      }));
    },
  });

  assert.equal(renderedRequests, 3);
  assert.equal(article.coverage, 'partial');
  assert.deepEqual(article.unresolved_features, [
    'dynamic-list',
    'rendered-request-failed',
  ]);
});

test('validation rejects an edge whose evidence predates its source profile', async () => {
  const dataset = structuredClone(await loadDataset());
  const edge = dataset.edges[0];
  edge.evidence.revision += 1;

  const result = validateDataset(dataset);

  assert.equal(result.valid, false);
  assert.ok(result.errors.includes(`Evidence revision mismatch: ${edge.from} -> ${edge.to}`));
});

test('one run uses current semantics for every changed article and preserves incoming links', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'isorropia-multi-update-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDirectory = path.join(root, 'data');
  const privateDirectory = path.join(root, 'private');
  await cp(sourceData, dataDirectory, { recursive: true });
  const goldenPath = path.join(dataDirectory, 'golden-pairs.json');
  const golden = JSON.parse(await readFile(goldenPath, 'utf8'));
  await writeFile(
    goldenPath,
    `${JSON.stringify(golden.filter((item) =>
      !['scp-006', 'scp-3301'].includes(item.left) &&
      !['scp-006', 'scp-3301'].includes(item.right),
    ), null, 2)}\n`,
  );
  const dataset = await loadDataset(dataDirectory);
  const index = sourceIndexFor(dataset);
  const changedPageIds = ['scp-006', 'scp-3301'];
  for (const pageId of changedPageIds) {
    index[pageId.toUpperCase()].history.push({});
  }
  const articleSource = Object.fromEntries(changedPageIds.map((pageId) => [
    pageId.toUpperCase(),
    {
      ...index[pageId.toUpperCase()],
      link: pageId,
      raw_source: `+ Description\n${pageId.toUpperCase()} changes local reality after direct contact.`,
    },
  ]));
  const fetchImpl = async (input) => {
    const url = String(input);
    return url.endsWith('/index.json')
      ? new Response(JSON.stringify(index), { status: 200 })
      : new Response(JSON.stringify(articleSource), { status: 200 });
  };
  const modelRunner = {
    async extract(chunks) {
      return chunks.map((chunk) => ({
        extraction_chunk_id: chunk.chunk_id,
        page_id: chunk.page_id,
        source_revision: chunk.source_revision,
        claims: [{
          id: 'local-reality-game-manifestation',
          kind: 'effect',
          domain: 'reality',
          operation: 'manifest-game-world',
          target: 'local-reality',
          outcomes: ['physical-gameboard-manifestation'],
          preconditions: ['players-activate-the-game'],
          limitations: ['direct-contact-only'],
          role: 'anomalous-effect',
          operation_class: 'transform',
          domain_class: 'other',
          affected_state: 'other',
          direction: 'transform',
          chunk_ids: [chunk.chunk_id],
          evidence: [{
            revision: chunk.source_revision,
            section: 'Description',
            locator: `${chunk.page_id.toUpperCase()} changes local reality after direct contact.`,
          }],
        }],
        reading: {
          themes: ['foundation-mythos'],
          forms: ['game-manual'],
          structures: ['participatory'],
          tones: ['adventurous'],
          motifs: ['board-game'],
        },
      }));
    },
    async propose(candidates) {
      return candidates.map((candidate) => rejectedReview(candidate.review_id));
    },
    async verify(_candidates, proposals) {
      return proposals;
    },
  };

  const summary = await runMaintenance({
    limit: 2,
    dryRun: true,
    dataDirectory,
    privateDirectory,
    fetchImpl,
    modelRunner,
    now: new Date('2026-08-12T00:00:00Z'),
  });
  const proposal = await loadDataset(summary.proposal_directory);

  assert.deepEqual(summary.proposed, changedPageIds);
  assert.equal(
    proposal.edges.some((edge) => edge.from === 'scp-018' && edge.to === 'scp-006'),
    true,
  );
  for (const interaction of proposal.interactions) {
    for (const pageId of interaction.pages) {
      const profile = proposal.profiles.find((item) => item.page_id === pageId);
      assert.equal(interaction.source_revisions[pageId], profile.source_revision);
    }
  }
});

test('maintenance dry-run fills one missing semantic profile in a private proposal', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'isorropia-maintenance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDirectory = path.join(root, 'data');
  const privateDirectory = path.join(root, 'private');
  await cp(sourceData, dataDirectory, { recursive: true });
  await removeSemanticProfiles(dataDirectory, ['scp-002']);
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
  assert.equal(summary.accepted_interactions, 0);
  const proposal = await loadDataset(summary.proposal_directory);
  const semantic = proposal.semantics.find((item) => item.page_id === 'scp-002');
  assert.deepEqual(semantic.reviewed_modes, ['cycle', 'breach', 'double-feature']);
  const reviewPacket = await readFile(
    path.join(privateDirectory, 'runs', summary.run_id, 'review-packet.md'),
    'utf8',
  );
  assert.match(reviewPacket, /Revision:/);
  assert.match(reviewPacket, /double-feature:/);
  await assert.rejects(readFile(path.join(privateDirectory, 'state.json')), /ENOENT/);
  const applied = await applyMaintenanceRun({
    runId: summary.run_id,
    dataDirectory,
    privateDirectory,
    fetchImpl,
  });
  assert.equal(applied.applied, true);
  assert.ok(applied.changed_paths.includes('data/semantics.json'));
  const appliedDataset = await loadDataset(dataDirectory);
  assert.equal(
    appliedDataset.semantics.find((item) => item.page_id === 'scp-002').schema_version,
    2,
  );

  const gateRunner = rejectingModelRunner();
  const propose = gateRunner.propose;
  gateRunner.propose = async (candidates) => (await propose(candidates)).map((review, index) =>
    index === 0
      ? {
          ...review,
          verdict: 'accepted',
          mode_gate_passed: false,
          mode_gate_reason: 'The mode-specific relationship is insufficient.',
        }
      : review);
  await removeSemanticProfiles(dataDirectory, ['scp-002']);
  const gateSummary = await runMaintenance({
    limit: 1,
    dryRun: true,
    dataDirectory,
    privateDirectory: path.join(root, 'gate-private'),
    fetchImpl,
    modelRunner: gateRunner,
    now: new Date('2026-08-12T00:01:00Z'),
  });
  assert.equal(gateSummary.accepted_interactions, 0);
  assert.ok(gateSummary.rejected_interactions > 0);
});

test('maintenance retries only an article whose generated semantic evidence is invalid', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'isorropia-semantic-repair-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDirectory = path.join(root, 'data');
  const privateDirectory = path.join(root, 'private');
  await cp(sourceData, dataDirectory, { recursive: true });
  await removeSemanticProfiles(dataDirectory, ['scp-002']);
  const dataset = await loadDataset(dataDirectory);
  const index = sourceIndexFor(dataset);
  const fetchImpl = sourceFetch(index);
  const modelRunner = rejectingModelRunner();
  const validExtract = modelRunner.extract;
  let extractionCalls = 0;
  modelRunner.extract = async (chunks) => {
    extractionCalls += 1;
    const profiles = await validExtract(chunks);
    if (extractionCalls === 1) {
      profiles[0].claims[0].evidence[0].locator = 'This excerpt is not in the article.';
    }
    return profiles;
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

  assert.equal(extractionCalls, 2);
  assert.deepEqual(summary.proposed, ['scp-002']);
});

test('maintenance falls back to rendered offset content when raw source is only a dynamic shell', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'isorropia-rendered-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDirectory = path.join(root, 'data');
  const privateDirectory = path.join(root, 'private');
  await cp(sourceData, dataDirectory, { recursive: true });
  await removeSemanticProfiles(dataDirectory, ['scp-002']);
  const dataset = await loadDataset(dataDirectory);
  const index = sourceIndexFor(dataset);
  const requestedUrls = [];
  const fetchImpl = async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.endsWith('/index.json')) {
      return new Response(JSON.stringify(index), { status: 200 });
    }
    if (url.endsWith('/scp-002/offset/1')) {
      return new Response([
        '<html><body><div id="page-content">',
        '<p>SCP-002 converts introduced living humans into biological furniture.</p>',
        '<div class="collection">Unrelated author links</div>',
      ].join(''), { status: 200 });
    }
    return new Response(JSON.stringify({
      'SCP-002': {
        history: index['SCP-002'].history,
        link: 'scp-002',
        url: 'https://scp-wiki.wikidot.com/scp-002',
        raw_source: [
          '[[module css]]',
          '.substantive-looking-selector { display: none; }',
          '[[/module]]',
          '[[module ListPages]]',
          '%%content%%',
          '[[/module]]',
        ].join('\n'),
        raw_content: [
          '<div id="page-content"><p>Dynamic article introduction.</p>',
          '<a href="/scp-002/offset/1">Read revision</a>',
          '<a href="/scp-999">Ordinary article link</a>',
          '<iframe src="https://example.com/embed"></iframe></div>',
        ].join(''),
      },
    }), { status: 200 });
  };

  const summary = await runMaintenance({
    limit: 1,
    dryRun: true,
    dataDirectory,
    privateDirectory,
    fetchImpl,
    modelRunner: rejectingModelRunner(),
    now: new Date('2026-08-12T00:00:00Z'),
  });

  assert.deepEqual(summary.proposed, ['scp-002']);
  assert.equal(requestedUrls.some((url) => url.includes('/scp-999')), false);
  assert.equal(requestedUrls.some((url) => url.includes('example.com')), false);
  const proposal = await loadDataset(summary.proposal_directory);
  const semantic = proposal.semantics.find((item) => item.page_id === 'scp-002');
  assert.equal(semantic.coverage.status, 'partial');
  assert.deepEqual(semantic.coverage.unresolved_features, ['external-frame']);
});

test('maintenance reuses validated article and subject checkpoints after a later failure', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'isorropia-checkpoints-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDirectory = path.join(root, 'data');
  const privateDirectory = path.join(root, 'private');
  await cp(sourceData, dataDirectory, { recursive: true });
  await removeSemanticProfiles(dataDirectory, ['scp-002', 'scp-005']);
  const dataset = await loadDataset(dataDirectory);
  const index = sourceIndexFor(dataset);
  const pageIds = ['scp-002', 'scp-005'];
  const sourceById = Object.fromEntries(pageIds.map((pageId) => [
    pageId.toUpperCase(),
    {
      ...index[pageId.toUpperCase()],
      link: pageId,
      raw_source: `+ Description\n${pageId.toUpperCase()} produces an article-specific effect.`,
    },
  ]));
  const fetchImpl = async (input) => String(input).endsWith('/index.json')
    ? new Response(JSON.stringify(index), { status: 200 })
    : new Response(JSON.stringify(sourceById), { status: 200 });
  let extractionCalls = 0;
  let firstRun = true;
  const judgementCalls = [];
  const modelRunner = {
    async extract(chunks) {
      extractionCalls += 1;
      return chunks.map((chunk) => ({
        extraction_chunk_id: chunk.chunk_id,
        page_id: chunk.page_id,
        source_revision: chunk.source_revision,
        claims: [{
          id: 'article-specific-effect',
          kind: 'effect',
          domain: 'test',
          operation: 'produce',
          target: 'test-subject',
          outcomes: ['test-effect'],
          preconditions: [],
          limitations: [],
          role: 'anomalous-effect',
          operation_class: 'other',
          domain_class: 'other',
          affected_state: 'other',
          direction: 'none',
          chunk_ids: [chunk.chunk_id],
          evidence: [{
            revision: chunk.source_revision,
            section: 'Description',
            locator: `${chunk.page_id.toUpperCase()} produces an article-specific effect.`,
          }],
        }],
        reading: {
          themes: ['test'],
          forms: ['report'],
          structures: ['linear'],
          tones: ['clinical'],
          motifs: ['test'],
        },
      }));
    },
    async propose(candidates) {
      const subjects = [...new Set(candidates.map((candidate) =>
        candidate.subject_page_id,
      ))].sort();
      judgementCalls.push(subjects);
      if (firstRun && subjects.includes('scp-005')) {
        throw new Error('simulated scp-005 judgement failure');
      }
      return candidates
        .filter((candidate) => !firstRun || candidate.subject_page_id === 'scp-002')
        .map((candidate) => reviewForCandidate(candidate));
    },
    async verify(_candidates, proposals) {
      return proposals;
    },
  };

  await assert.rejects(
    runMaintenance({
      limit: 2,
      dryRun: true,
      dataDirectory,
      privateDirectory,
      fetchImpl,
      modelRunner,
      now: new Date('2026-08-12T00:00:00Z'),
    }),
    /simulated scp-005 judgement failure/,
  );
  const callsBeforeResume = judgementCalls.length;
  firstRun = false;
  const summary = await runMaintenance({
    limit: 2,
    dryRun: true,
    dataDirectory,
    privateDirectory,
    fetchImpl,
    modelRunner,
    now: new Date('2026-08-12T00:01:00Z'),
  });

  assert.equal(extractionCalls, 1);
  assert.ok(judgementCalls.slice(callsBeforeResume).length > 0);
  assert.equal(
    judgementCalls.slice(callsBeforeResume).every((subjects) =>
      subjects.includes('scp-005')),
    true,
  );
  assert.deepEqual(summary.proposed, pageIds);
});

test('publish uses an explicit data allowlist and creates only a draft PR', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'isorropia-publish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repositoryDirectory = path.join(root, 'repo');
  const dataDirectory = path.join(repositoryDirectory, 'data');
  const privateDirectory = path.join(root, 'private');
  await cp(sourceData, dataDirectory, { recursive: true });
  await removeSemanticProfiles(dataDirectory, ['scp-002']);
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
  const failureCalls = [];
  let failureStatusCalls = 0;
  const failingRunner = async (command, args, cwd) => {
    failureCalls.push({ command, args, cwd });
    if (command === 'git' && args[0] === 'branch') return { stdout: 'main\n', stderr: '' };
    if (command === 'git' && args[0] === 'rev-parse') return { stdout: '0123456789abcdef\n', stderr: '' };
    if (command === 'git' && args[0] === 'status') {
      failureStatusCalls += 1;
      return failureStatusCalls === 1
        ? { stdout: '', stderr: '' }
        : { stdout: ' M data/interactions.json\n M data/manifest.json\n M data/semantics.json', stderr: '' };
    }
    if (command === 'git' && args[0] === 'commit') throw new Error('simulated commit failure');
    return { stdout: '', stderr: '' };
  };
  await assert.rejects(
    publishMaintenanceRun({
      runId: run.run_id,
      repositoryDirectory,
      dataDirectory,
      privateDirectory,
      fetchImpl,
      commandRunner: failingRunner,
    }),
    /simulated commit failure/,
  );
  const recovery = JSON.parse(await readFile(
    path.join(privateDirectory, 'runs', run.run_id, 'publish-recovery.json'),
    'utf8',
  ));
  assert.equal(recovery.phase, 'commit');
  assert.equal(recovery.commit_created, false);
  assert.equal(failureCalls.some((call) =>
    call.command === 'git' && call.args[0] === 'switch' && call.args[1] === 'main'), false);
  await rm(dataDirectory, { recursive: true, force: true });
  await cp(sourceData, dataDirectory, { recursive: true });
  const pushCalls = [];
  let pushStatusCalls = 0;
  const pushFailingRunner = async (command, args, cwd) => {
    pushCalls.push({ command, args, cwd });
    if (command === 'git' && args[0] === 'branch') return { stdout: 'main\n', stderr: '' };
    if (command === 'git' && args[0] === 'rev-parse') return { stdout: '0123456789abcdef\n', stderr: '' };
    if (command === 'git' && args[0] === 'status') {
      pushStatusCalls += 1;
      return pushStatusCalls === 1
        ? { stdout: '', stderr: '' }
        : { stdout: ' M data/interactions.json\n M data/manifest.json\n M data/semantics.json', stderr: '' };
    }
    if (command === 'git' && args[0] === 'push') throw new Error('simulated push failure');
    return { stdout: '', stderr: '' };
  };
  await assert.rejects(
    publishMaintenanceRun({
      runId: run.run_id,
      repositoryDirectory,
      dataDirectory,
      privateDirectory,
      fetchImpl,
      commandRunner: pushFailingRunner,
    }),
    /simulated push failure/,
  );
  const pushRecovery = JSON.parse(await readFile(
    path.join(privateDirectory, 'runs', run.run_id, 'publish-recovery.json'),
    'utf8',
  ));
  assert.equal(pushRecovery.phase, 'push');
  assert.equal(pushRecovery.commit_created, true);
  assert.deepEqual(pushCalls.at(-1).args, ['switch', 'main']);
  await rm(dataDirectory, { recursive: true, force: true });
  await cp(sourceData, dataDirectory, { recursive: true });
  const calls = [];
  let statusCalls = 0;
  const commandRunner = async (command, args, cwd) => {
    calls.push({ command, args, cwd });
    if (command === 'git' && args[0] === 'branch') {
      return { stdout: 'main\n', stderr: '' };
    }
    if (command === 'git' && args[0] === 'rev-parse') {
      return { stdout: '0123456789abcdef\n', stderr: '' };
    }
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
  assert.deepEqual(calls.at(-1).args, ['switch', 'main']);
});

test('scheduled maintenance starts from a clean fast-forwarded main checkout', async () => {
  const calls = [];
  let statusCalls = 0;
  const commandRunner = async (command, args, cwd) => {
    calls.push({ command, args, cwd });
    if (command === 'git' && args[0] === 'status') {
      statusCalls += 1;
      return { stdout: '', stderr: '' };
    }
    if (command === 'git' && args[0] === 'rev-parse') {
      return { stdout: '0123456789abcdef\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };

  await prepareMaintenanceCheckout({
    repositoryDirectory: '/srv/isorropia',
    commandRunner,
  });

  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ['status', '--porcelain'],
      ['switch', 'main'],
      ['fetch', 'origin', 'main'],
      ['merge', '--ff-only', 'origin/main'],
      ['rev-parse', 'HEAD'],
      ['rev-parse', 'origin/main'],
      ['status', '--porcelain'],
    ],
  );
  assert.equal(statusCalls, 2);
});

test('last-run status records run and publication outcomes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'isorropia-last-run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeLastRunStatus(root, {
    status: 'success',
    started_at: '2026-08-12T00:00:00.000Z',
    updated_at: '2026-08-12T00:10:00.000Z',
    run_id: '20260812T000000Z',
    pr_url: 'https://github.com/example/repo/pull/1',
  });
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'last-run.json'), 'utf8')), {
    status: 'success',
    started_at: '2026-08-12T00:00:00.000Z',
    updated_at: '2026-08-12T00:10:00.000Z',
    run_id: '20260812T000000Z',
    pr_url: 'https://github.com/example/repo/pull/1',
  });
});

test('catalog expansion adds a profile only when an accepted interaction survives validation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'isorropia-expansion-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDirectory = path.join(root, 'data');
  const privateDirectory = path.join(root, 'private');
  await cp(sourceData, dataDirectory, { recursive: true });
  const initial = await loadDataset(dataDirectory);
  await writeFile(
    path.join(dataDirectory, 'golden-pairs.json'),
    `${JSON.stringify(initial.golden.map(({ maximum_rank: _rank, ...item }) => item), null, 2)}\n`,
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
    async extract(chunks) {
      return [{
        extraction_chunk_id: chunks[0].chunk_id,
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
          role: 'anomalous-effect',
          operation_class: 'restore',
          domain_class: 'biology',
          affected_state: 'biological-integrity',
          direction: 'restore',
          chunk_ids: [chunks[0].chunk_id],
          evidence: [{
            revision: 1,
            section: '',
            locator: 'SCP-9100 restores damaged living tissue after direct contact.',
          }],
        }],
        reading: {
          themes: ['restoration'], forms: ['containment file'],
          structures: ['description'], tones: ['clinical'], motifs: ['healing'],
        },
      }];
    },
    async propose(candidates) {
      let accepted = false;
      return candidates.map((candidate) => {
        if (
          !accepted &&
          candidate.mode === 'double-feature'
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
            mode_gate_passed: true,
            mode_gate_reason: 'The requested reading mode is specifically supported.',
            proof: {
              mode: 'double-feature',
              relation: 'contrast',
              anchors: [
                { page_id: candidate.left.page_id, claim_refs: [candidate.left.claims[0].id] },
                { page_id: candidate.right.page_id, claim_refs: [candidate.right.claims[0].id] },
              ],
              reading_order: [candidate.left.page_id, candidate.right.page_id],
              ordering_gain: 'The first mechanism establishes a baseline that the second revises.',
              replacement_test: 'Replacing either article removes the specific restoration contrast.',
              bridge_assumptions: ['The reading order is curatorial.'],
            },
          };
        }
        return rejectedReview(candidate.review_id);
      });
    },
    async verify(_candidates, proposals) {
      return proposals;
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
  assert.equal(proposal.profiles.some((profile) => profile.page_id === 'scp-9100'), true);
  assert.equal(
    proposal.semantics.find((semantic) => semantic.page_id === 'scp-9100')
      .claims[0].evidence[0].section,
    'Article source',
  );
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
      async propose(candidates) {
        return candidates.map((candidate) => rejectedReview(candidate.review_id));
      },
      async verify(_candidates, proposals) {
        return proposals;
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
        raw_source: '+ Description\nSCP-002 converts introduced living humans[[footnote]]A note.[[/footnote]] into biological furniture.',
      },
    }), { status: 200 });
  };
}

function rejectingModelRunner() {
  return {
    async extract(chunks) {
      return chunks.map((chunk) => ({
        extraction_chunk_id: chunk.chunk_id,
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
          role: 'anomalous-effect',
          operation_class: 'transform',
          domain_class: 'biology',
          affected_state: 'biological-integrity',
          direction: 'transform',
          chunk_ids: [chunk.chunk_id],
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
    async propose(candidates) {
      return candidates.map((candidate) => reviewForCandidate(candidate));
    },
    async verify(_candidates, proposals) {
      return proposals;
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
    mode_gate_passed: false,
    mode_gate_reason: 'The requested mode is not supported by both articles.',
  };
}

function reviewForCandidate(candidate) {
  if (
    candidate.mode === 'double-feature' &&
    candidate.left.page_id === 'scp-002' &&
    candidate.right.page_id === 'scp-017'
  ) {
    return {
      review_id: candidate.review_id,
      verdict: 'accepted',
      mechanism: 'The two article-specific spatial threats form a deliberate reading contrast.',
      left_claim_refs: [candidate.left.claims[0].id],
      right_claim_refs: [candidate.right.claims[0].id],
      causal_chain: ['Read the enclosed transformation.', 'Then read the lighting-dependent threat.'],
      explanation: 'The reading order contrasts occupied interior space with a threat governed by environmental visibility.',
      assumption: 'The relationship is curatorial.',
      limitation: 'No shared continuity is claimed.',
      rubric: {
        mode_fit: 'core', coherence: 'complete',
        specificity: 'article-specific', discovery_value: 'high',
      },
      support: 'B',
      reason: '',
      mode_gate_passed: true,
      mode_gate_reason: 'Both article-specific mechanisms support the requested reading mode.',
      proof: {
        mode: 'double-feature',
        relation: 'contrast',
        anchors: [
          {
            page_id: candidate.left.page_id,
            claim_refs: [candidate.left.claims[0].id],
          },
          {
            page_id: candidate.right.page_id,
            claim_refs: [candidate.right.claims[0].id],
          },
        ],
        reading_order: [candidate.left.page_id, candidate.right.page_id],
        ordering_gain: 'The first spatial premise establishes the baseline that the second reverses.',
        replacement_test: 'Replacing either article removes its specific transformation or visibility mechanism.',
        bridge_assumptions: ['The reading order is curatorial.'],
      },
    };
  }
  return rejectedReview(candidate.review_id);
}
