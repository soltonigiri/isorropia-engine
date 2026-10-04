import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { analysisPolicyDigests, stableDigest } from './analysis-policy.js';
import { defaultDataDirectory, loadDataset } from './data.js';
import {
  normalizeInteractionReviews,
  rejectInvalidAcceptedReviews,
  validateReviews,
} from './interaction-review.js';
import {
  CodexQualitativeModelRunner,
  verifyAcceptedProposals,
  type InteractionCandidate,
  type JudgementReview,
  type QualitativeModelRunner,
} from './model-runner.js';
import { defaultPrivateDirectory } from './maintenance.js';
import type { Mode } from './types.js';

type EvaluationFixture = {
  mode: Mode;
  pages: [string, string];
  decision: 'keep' | 'reject' | 'revise' | 'defer';
  source_revisions: Record<string, number>;
  maximum_support?: 'A' | 'B' | 'C';
};

export type QualitativeEvaluationCase = {
  review_id: string;
  expected: EvaluationFixture['decision'];
  expected_maximum_support?: 'A' | 'B' | 'C';
  observed: JudgementReview['verdict'];
  observed_support?: 'A' | 'B' | 'C';
  agrees: boolean | null;
  revision_changes: Record<string, { expected: number; current: number }>;
  review: JudgementReview;
};

export type QualitativeEvaluationReport = {
  version: 1;
  generated_at: string;
  database_version: string;
  cases: number;
  comparable: number;
  agreements: number;
  disagreements: number;
  deferred: number;
  revision_changes: number;
  results: QualitativeEvaluationCase[];
};

const MAX_CONCURRENT_GROUPS = 4;

export async function evaluateQualitativeFixtures(options: {
  fixturePath: string;
  dataDirectory?: string;
  privateDirectory?: string;
  modelRunner?: QualitativeModelRunner;
  now?: Date;
}): Promise<{ report: QualitativeEvaluationReport; output_directory: string }> {
  const dataDirectory = options.dataDirectory ?? defaultDataDirectory();
  const privateDirectory = options.privateDirectory ?? defaultPrivateDirectory();
  const dataset = await loadDataset(dataDirectory);
  const fixtures = JSON.parse(await readFile(options.fixturePath, 'utf8')) as EvaluationFixture[];
  validateFixtures(fixtures);
  const semantics = new Map(dataset.semantics.map((semantic) => [semantic.page_id, semantic]));
  const profiles = new Map(dataset.profiles.map((profile) => [profile.page_id, profile]));
  const candidates = fixtures.map((fixture): InteractionCandidate => {
    const pages = [...fixture.pages].sort() as [string, string];
    const left = semantics.get(pages[0]);
    const right = semantics.get(pages[1]);
    if (!left || !right) throw new Error(`Evaluation fixture has an unknown page: ${fixture.pages.join(', ')}`);
    return {
      review_id: `${fixture.mode}:${pages.join(':')}`,
      subject_page_id: pages[0],
      mode: fixture.mode,
      left,
      right,
      left_title: profiles.get(pages[0])?.title ?? pages[0].toUpperCase(),
      right_title: profiles.get(pages[1])?.title ?? pages[1].toUpperCase(),
      retrieval_reasons: ['curated-evaluation-case'],
    };
  });
  const timestamp = (options.now ?? new Date()).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const evaluationsDirectory = path.join(privateDirectory, 'evaluations');
  await mkdir(evaluationsDirectory, { recursive: true });
  const outputDirectory = await mkdtemp(path.join(evaluationsDirectory, `${timestamp}-`));
  const groups = evaluationGroups(candidates, dataset.analysisPolicy.review.batch_size);
  const modelRunner = options.modelRunner ?? new CodexQualitativeModelRunner();
  const reviews: JudgementReview[] = [];
  for (let offset = 0; offset < groups.length; offset += MAX_CONCURRENT_GROUPS) {
    const results = await Promise.all(groups.slice(offset, offset + MAX_CONCURRENT_GROUPS)
      .map((group) => evaluateGroup({
        group,
        modelRunner,
        outputDirectory,
        privateDirectory,
        dataset,
        semantics,
      })));
    reviews.push(...results.flat());
  }
  const reviewById = new Map(reviews.map((review) => [review.review_id, review]));
  const supportRank = { A: 3, B: 2, C: 1 } as const;
  const results = fixtures.map((fixture): QualitativeEvaluationCase => {
    const pages = [...fixture.pages].sort() as [string, string];
    const reviewId = `${fixture.mode}:${pages.join(':')}`;
    const review = reviewById.get(reviewId)!;
    const revisionChanges = Object.fromEntries(pages.flatMap((pageId) => {
      const expected = fixture.source_revisions[pageId];
      const current = semantics.get(pageId)!.source_revision;
      return expected === current ? [] : [[pageId, { expected, current }]];
    }));
    const agrees = fixture.decision === 'defer' || Object.keys(revisionChanges).length > 0
      ? null
      : fixture.decision === 'reject'
        ? review.verdict === 'rejected'
        : review.verdict === 'accepted' && (
          !fixture.maximum_support ||
          supportRank[review.support] <= supportRank[fixture.maximum_support]
        );
    return {
      review_id: reviewId,
      expected: fixture.decision,
      ...(fixture.maximum_support ? { expected_maximum_support: fixture.maximum_support } : {}),
      observed: review.verdict,
      ...(review.verdict === 'accepted' ? { observed_support: review.support } : {}),
      agrees,
      revision_changes: revisionChanges,
      review,
    };
  });
  const comparable = results.filter((result) => result.agrees !== null);
  const report: QualitativeEvaluationReport = {
    version: 1,
    generated_at: options.now?.toISOString() ?? new Date().toISOString(),
    database_version: dataset.manifest.database_version,
    cases: results.length,
    comparable: comparable.length,
    agreements: comparable.filter((result) => result.agrees).length,
    disagreements: comparable.filter((result) => !result.agrees).length,
    deferred: results.filter((result) => result.expected === 'defer').length,
    revision_changes: results.filter((result) => Object.keys(result.revision_changes).length > 0).length,
    results,
  };
  await atomicWrite(path.join(outputDirectory, 'evaluation.json'), `${JSON.stringify(report, null, 2)}\n`);
  return { report, output_directory: outputDirectory };
}

function evaluationGroups(candidates: InteractionCandidate[], size: number): InteractionCandidate[][] {
  const groups: InteractionCandidate[][] = [];
  for (const mode of ['cycle', 'breach', 'double-feature'] as const) {
    const modeCandidates = candidates.filter((candidate) => candidate.mode === mode);
    for (let offset = 0; offset < modeCandidates.length; offset += size) {
      groups.push(modeCandidates.slice(offset, offset + size));
    }
  }
  return groups;
}

async function evaluateGroup(options: {
  group: InteractionCandidate[];
  modelRunner: QualitativeModelRunner;
  outputDirectory: string;
  privateDirectory: string;
  dataset: Awaited<ReturnType<typeof loadDataset>>;
  semantics: Map<string, InteractionCandidate['left']>;
}): Promise<JudgementReview[]> {
  const cacheKey = stableDigest({
    review_contract: analysisPolicyDigests({
      policy: options.dataset.analysisPolicy,
      ontology: options.dataset.semanticOntology,
    }).review_modes[options.group[0]!.mode],
    candidates: options.group,
  });
  const cachePath = path.join(options.privateDirectory, 'evaluation-cache', `${cacheKey}.json`);
  try {
    const cached = JSON.parse(await readFile(cachePath, 'utf8')) as JudgementReview[];
    validateReviews(options.group, cached, options.semantics, options.dataset);
    return cached;
  } catch {
    // An absent or invalid private checkpoint is regenerated.
  }
  const proposals = await options.modelRunner.propose(options.group, options.outputDirectory);
  const verified = await verifyAcceptedProposals(
    options.modelRunner,
    options.group,
    proposals,
    options.outputDirectory,
  );
  const reviews = rejectInvalidAcceptedReviews(
    options.group,
    normalizeInteractionReviews(options.group, verified),
    options.semantics,
    options.dataset,
  );
  validateReviews(options.group, reviews, options.semantics, options.dataset);
  await atomicWrite(cachePath, `${JSON.stringify(reviews, null, 2)}\n`);
  return reviews;
}

function validateFixtures(fixtures: EvaluationFixture[]): void {
  const seen = new Set<string>();
  for (const fixture of fixtures) {
    const key = `${fixture.mode}:${[...fixture.pages].sort().join(':')}`;
    if (seen.has(key)) throw new Error(`Duplicate evaluation fixture: ${key}`);
    seen.add(key);
    if (fixture.pages.length !== 2 || fixture.pages[0] === fixture.pages[1]) {
      throw new Error(`Invalid evaluation pages: ${key}`);
    }
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, content, 'utf8');
  await rename(temporaryPath, filePath);
}
