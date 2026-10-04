import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { buildArtifacts } from './artifacts.js';
import { analysisPolicyDigests, interactionSemanticDigest } from './analysis-policy.js';
import { defaultDataDirectory, loadDataset } from './data.js';
import { IsorropiaEngine } from './engine.js';
import {
  CodexQualitativeModelRunner,
  EXTRACTION_MODEL,
  JUDGEMENT_MODEL,
  verifyAcceptedProposals,
  type ArticleChunk,
  type InteractionCandidate,
  type JudgementReview,
  type QualitativeModelRunner,
} from './model-runner.js';
import {
  articleChunks,
  extractionBatches,
  loadArticle,
  normalizeWikidotDisplayText,
  type LoadedArticle,
} from './article-source.js';
import {
  buildInteractionCandidates,
  compareInteractionQuality,
  judgementGroups,
  normalizeInteractionReviews,
  rejectInvalidAcceptedReviews,
  reviewsToInteractions,
  validateReviews,
} from './interaction-review.js';
import {
  qualitativeContractDigests,
  qualitativeReviewContractDigest,
} from './contracts.js';
import {
  fetchItemsIndex,
  normalizedSourceKey,
  sourceRevision,
  type SourceIndexEntry,
} from './source-api.js';
import {
  MODES,
  type Dataset,
  type Edge,
  type ExtractedSemanticProfile,
  type PairInteraction,
  type Profile,
  type SelectionPolicy,
  type SemanticClaim,
  type SemanticProfile,
} from './types.js';
import { validateDataset, validateGoldenRankings } from './validate.js';
import { calculateDatabaseVersion } from './version.js';
import {
  compileProfileEffects,
  compileReadingThemes,
} from './profile-compiler.js';

type CurationEntry = {
  page_id: string;
  known_not?: string[];
};

const execFileAsync = promisify(execFile);
const MAX_CONCURRENT_JUDGEMENTS = 6;

export const PUBLIC_DATA_PATHS = [
  'data/curation.json',
  'data/semantics.json',
  'data/interactions.json',
  'data/edges.jsonl',
  'data/manifest.json',
  'data/semantic-ontology.json',
  'data/analysis-policy.json',
] as const;

export type MaintenanceReason =
  | 'source-changed'
  | 'missing-semantics'
  | 'semantic-policy-changed'
  | 'review-policy-changed'
  | 'catalog-expansion';

export type MaintenancePlanEntry = {
  page_id: string;
  source_revision: number;
  title: string;
  reason: MaintenanceReason;
  selection_score?: number;
};

export type MaintenancePlan = {
  version: 1;
  run_id: string;
  created_at: string;
  catalog_count: number;
  analysis_limit: number;
  bootstrap_complete: boolean;
  entries: MaintenancePlanEntry[];
};

type DeferredEntry = {
  source_revision: number;
  catalog_count: number;
  reason: string;
};

type PendingEntry = {
  source_revision: number;
  catalog_count: number;
  run_id: string;
  pr_url: string;
};

type MaintenanceState = {
  version: 1;
  catalog_count: number;
  deferred: Record<string, DeferredEntry>;
  pending: Record<string, PendingEntry>;
};

export type MaintenanceRunSummary = {
  run_id: string;
  dry_run: boolean;
  analyzed: string[];
  proposed: string[];
  deferred: string[];
  accepted_interactions: number;
  rejected_interactions: number;
  proposal_directory: string;
  validation: 'passed';
};

export type CommandRunner = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<{ stdout: string; stderr: string }>;

export type LastRunStatus = {
  status: 'started' | 'running' | 'success' | 'failure';
  started_at: string;
  updated_at: string;
  run_id?: string;
  pr_url?: string;
  error?: string;
};

export function defaultPrivateDirectory(): string {
  return path.resolve('.private', 'maintenance');
}

export async function prepareMaintenanceCheckout(options: {
  repositoryDirectory?: string;
  commandRunner?: CommandRunner;
} = {}): Promise<void> {
  const repositoryDirectory = options.repositoryDirectory ?? path.resolve('.');
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const status = await commandRunner('git', ['status', '--porcelain'], repositoryDirectory);
  if (status.stdout.trim()) {
    throw new Error('Scheduled maintenance requires a clean dedicated checkout');
  }
  await commandRunner('git', ['switch', 'main'], repositoryDirectory);
  await commandRunner('git', ['fetch', 'origin', 'main'], repositoryDirectory);
  await commandRunner('git', ['merge', '--ff-only', 'origin/main'], repositoryDirectory);
  const localHead = await commandRunner('git', ['rev-parse', 'HEAD'], repositoryDirectory);
  const remoteHead = await commandRunner(
    'git',
    ['rev-parse', 'origin/main'],
    repositoryDirectory,
  );
  if (localHead.stdout.trim() !== remoteHead.stdout.trim()) {
    throw new Error('Scheduled maintenance requires main to match origin/main');
  }
  const after = await commandRunner('git', ['status', '--porcelain'], repositoryDirectory);
  if (after.stdout.trim()) {
    throw new Error('Scheduled maintenance checkout is not clean after updating main');
  }
}

export async function createMaintenancePlan(options: {
  limit?: number;
  dataDirectory?: string;
  privateDirectory?: string;
  fetchImpl?: typeof fetch;
  now?: Date;
  runId?: string;
} = {}): Promise<MaintenancePlan> {
  const dataDirectory = options.dataDirectory ?? defaultDataDirectory();
  const privateDirectory = options.privateDirectory ?? defaultPrivateDirectory();
  const now = options.now ?? new Date();
  const dataset = await loadDataset(dataDirectory);
  const limit = boundedLimit(
    options.limit ?? dataset.selectionPolicy.weekly_analysis_limit,
    dataset.selectionPolicy,
  );
  const index = await fetchItemsIndex(options.fetchImpl);
  const catalogCount = eligibleCatalogEntries(index, dataset.selectionPolicy, now)
    .length;
  const state = await readState(privateDirectory);
  reconcilePending(state, dataset);

  const semantics = new Map(dataset.semantics.map((item) => [item.page_id, item]));
  const policyDigests = analysisPolicyDigests({
    policy: dataset.analysisPolicy,
    ontology: dataset.semanticOntology,
  });
  const semanticPolicyDigest = policyDigests.semantic;
  const staleReviewSubjects = new Set(dataset.interactions
    .filter((interaction) =>
      interaction.verdict === 'accepted' &&
      interaction.review_policy_digest !== policyDigests.review_modes[interaction.mode])
    .map((interaction) => interaction.pages[0]));
  const sourceChanged: MaintenancePlanEntry[] = [];
  const missingSemantics: MaintenancePlanEntry[] = [];
  for (const profile of [...dataset.profiles].sort(comparePageIds)) {
    const source = sourceEntry(index, profile.page_id);
    const entry = planEntry(profile.page_id, source);
    if (entry.source_revision !== profile.source_revision) {
      sourceChanged.push({ ...entry, reason: 'source-changed' });
      continue;
    }
    const semantic = semantics.get(profile.page_id);
    if (!semantic || !hasAllReviewedModes(semantic)) {
      missingSemantics.push({ ...entry, reason: 'missing-semantics' });
    } else if (semantic.semantic_policy_digest !== semanticPolicyDigest) {
      missingSemantics.push({ ...entry, reason: 'semantic-policy-changed' });
    } else if (staleReviewSubjects.has(profile.page_id)) {
      missingSemantics.push({ ...entry, reason: 'review-policy-changed' });
    }
  }
  const bootstrap = [...sourceChanged, ...missingSemantics];
  const bootstrapComplete = bootstrap.length === 0;
  const entries = bootstrapComplete
    ? rankExpansionCandidates({
        index,
        dataset,
        policy: dataset.selectionPolicy,
        state,
        catalogCount,
        now,
      }).slice(0, limit)
    : bootstrap.slice(0, limit);
  const runId = options.runId ?? `${makeRunId(now)}-${randomUUID().slice(0, 8)}`;
  const plan: MaintenancePlan = {
    version: 1,
    run_id: runId,
    created_at: now.toISOString(),
    catalog_count: catalogCount,
    analysis_limit: limit,
    bootstrap_complete: bootstrapComplete,
    entries,
  };
  await writeJson(path.join(privateDirectory, 'runs', runId, 'plan.json'), plan);
  return plan;
}

export function rankExpansionCandidates(options: {
  index: Record<string, SourceIndexEntry>;
  dataset: Dataset;
  policy: SelectionPolicy;
  state?: MaintenanceState;
  catalogCount?: number;
  now?: Date;
}): MaintenancePlanEntry[] {
  const now = options.now ?? new Date();
  const eligible = eligibleCatalogEntries(options.index, options.policy, now);
  const selected = new Set(options.dataset.profiles.map((profile) => profile.page_id));
  const state = options.state ?? emptyState();
  const catalogCount = options.catalogCount ?? eligible.length;
  const candidates = eligible.filter(({ pageId, source }) => {
    if (selected.has(pageId)) return false;
    return !isHeld(pageId, sourceRevision(source), catalogCount, state);
  });
  const ratings = candidates.map(({ source }) => source.rating ?? 0).sort((a, b) => a - b);
  const existingTags = new Set(options.dataset.profiles.flatMap((profile) => profile.tags));
  const seriesCounts = new Map<string, number>();
  for (const profile of options.dataset.profiles) {
    const series = profile.series ?? 'unassigned';
    seriesCounts.set(series, (seriesCounts.get(series) ?? 0) + 1);
  }
  const maximumSeriesCount = Math.max(1, ...seriesCounts.values());

  return candidates
    .map(({ pageId, source }) => {
      const tags = meaningfulTags(source.tags ?? []);
      const novelTags = tags.filter((tag) => !existingTags.has(tag)).length;
      const ratingPercentile = percentile(source.rating ?? 0, ratings);
      const tagNovelty = tags.length === 0 ? 0 : novelTags / tags.length;
      const references = (source.references ?? []).map(normalizeReference);
      const adjacent = references.filter((reference) => selected.has(reference)).length;
      const referenceAdjacency = Math.min(1, adjacent / 3);
      const seriesCount = seriesCounts.get(source.series ?? 'unassigned') ?? 0;
      const seriesUnderrepresentation = 1 - seriesCount / maximumSeriesCount;
      const weights = options.policy.weights;
      const score =
        ratingPercentile * weights.rating_percentile +
        tagNovelty * weights.tag_novelty +
        referenceAdjacency * weights.reference_adjacency +
        seriesUnderrepresentation * weights.series_underrepresentation;
      return {
        ...planEntry(pageId, source),
        reason: 'catalog-expansion' as const,
        selection_score: round(score, 6),
      };
    })
    .sort(
      (left, right) =>
        (right.selection_score ?? 0) - (left.selection_score ?? 0) ||
        left.page_id.localeCompare(right.page_id),
    );
}

export async function runMaintenance(options: {
  limit?: number;
  dryRun?: boolean;
  dataDirectory?: string;
  privateDirectory?: string;
  fetchImpl?: typeof fetch;
  modelRunner?: QualitativeModelRunner;
  now?: Date;
} = {}): Promise<MaintenanceRunSummary> {
  const dataDirectory = options.dataDirectory ?? defaultDataDirectory();
  const privateDirectory = options.privateDirectory ?? defaultPrivateDirectory();
  const plan = await createMaintenancePlan({
    limit: options.limit,
    dataDirectory,
    privateDirectory,
    fetchImpl: options.fetchImpl,
    now: options.now,
  });
  const runDirectory = path.join(privateDirectory, 'runs', plan.run_id);
  const dataset = await loadDataset(dataDirectory);
  if (plan.entries.length === 0) {
    const summary: MaintenanceRunSummary = {
      run_id: plan.run_id,
      dry_run: options.dryRun ?? false,
      analyzed: [],
      proposed: [],
      deferred: [],
      accepted_interactions: 0,
      rejected_interactions: 0,
      proposal_directory: path.join(runDirectory, 'proposal', 'data'),
      validation: 'passed',
    };
    await prepareProposalData(dataDirectory, runDirectory);
    await writeJson(path.join(runDirectory, 'summary.json'), summary);
    await writeReviewPacket({
      runDirectory,
      plan,
      before: dataset,
      after: dataset,
    });
    return summary;
  }

  const index = await fetchItemsIndex(options.fetchImpl);
  const articles: LoadedArticle[] = [];
  for (const entry of plan.entries) {
    const source = sourceEntry(index, entry.page_id);
    if (sourceRevision(source) !== entry.source_revision) {
      throw new Error(`Source revision changed during run: ${entry.page_id}`);
    }
    if (entry.reason === 'review-policy-changed') continue;
    articles.push(
      await loadArticle({
        entry,
        source,
        privateDirectory,
        fetchImpl: options.fetchImpl,
        sourceLimits: dataset.analysisPolicy.source,
      }),
    );
  }
  const policyDigests = analysisPolicyDigests({
    policy: dataset.analysisPolicy,
    ontology: dataset.semanticOntology,
  });
  const modelRunner = options.modelRunner ?? new CodexQualitativeModelRunner();
  const extracted = new Map<string, ExtractedSemanticProfile>();
  const deferred = new Map<string, string>();
  const chunks = articles.flatMap(articleChunks);
  for (const batch of extractionBatches(chunks)) {
    try {
      mergeExtractionBatch(
        extracted,
        await cachedExtraction({
          modelRunner,
          chunks: batch,
          ontology: dataset.semanticOntology,
          privateDirectory,
          runDirectory,
        }),
      );
    } catch {
      const repairs = await Promise.all(
        [...new Set(batch.map((chunk) => chunk.page_id))].map(async (pageId) => {
          const entry = plan.entries.find((item) => item.page_id === pageId)!;
          try {
            return { pageId, semantic: await validatedArticleExtraction({
              modelRunner,
              chunks: chunks.filter((chunk) => chunk.page_id === pageId),
              article: articles.find((article) => article.entry.page_id === pageId)!,
              ontology: dataset.semanticOntology,
              privateDirectory,
              runDirectory,
            }) };
          } catch (individualError) {
            return { pageId, entry, error: individualError };
          }
        }),
      );
      for (const repair of repairs) {
        if (repair.semantic) {
          extracted.set(repair.pageId, repair.semantic);
        } else if (repair.entry?.reason === 'catalog-expansion') {
          deferred.set(repair.pageId, errorMessage(repair.error));
        } else {
          throw repair.error;
        }
      }
    }
  }

  const articleById = new Map(articles.map((article) => [article.entry.page_id, article]));
  for (const entry of plan.entries.filter(
    (item) => item.reason !== 'review-policy-changed',
  )) {
    if (deferred.has(entry.page_id)) continue;
    const pageId = entry.page_id;
    const article = articleById.get(pageId)!;
    const semantic = extracted.get(pageId);
    try {
      if (!semantic) throw new Error(`Model omitted semantic profile: ${pageId}`);
      const grounded = retainSourceGroundedContent(
        repairEvidenceLocators(semantic, article),
        article,
      );
      validateGeneratedSemantic(grounded, article);
      extracted.set(pageId, grounded);
    } catch (error) {
      try {
        extracted.set(pageId, await validatedArticleExtraction({
          modelRunner,
          chunks: chunks.filter((chunk) => chunk.page_id === pageId),
          article,
          ontology: dataset.semanticOntology,
          privateDirectory,
          runDirectory,
        }));
      } catch (individualError) {
        if (entry.reason !== 'catalog-expansion') throw individualError;
        deferred.set(pageId, errorMessage(individualError));
        extracted.delete(pageId);
      }
    }
  }
  for (const pageId of extracted.keys()) {
    if (!articleById.has(pageId)) throw new Error(`Model returned an unrequested profile: ${pageId}`);
  }
  const finalized = new Map<string, SemanticProfile>();
  for (const [pageId, semantic] of extracted) {
    const article = articleById.get(pageId)!;
    finalized.set(pageId, normalizeEvidenceSections(finalizeSemanticProfile(
      semantic, article, dataset, policyDigests.semantic,
    )));
  }

  const previousSemantics = new Map(dataset.semantics.map((item) => [item.page_id, item]));
  const currentSemantics = new Map(previousSemantics);
  for (const [pageId, semantic] of finalized) currentSemantics.set(pageId, semantic);
  const contentReviewRequired = new Map([...finalized].filter(([pageId, semantic]) => {
    const previous = previousSemantics.get(pageId);
    return !previous || interactionSemanticDigest(previous) !== interactionSemanticDigest(semantic);
  }));
  const staleReviewKeys = new Set(dataset.interactions
    .filter((interaction) =>
      interaction.verdict === 'accepted' &&
      interaction.review_policy_digest !== policyDigests.review_modes[interaction.mode])
    .map(interactionKey));
  const staleReviewModes = MODES.filter((mode) => dataset.interactions.some(
    (interaction) => interaction.mode === mode && staleReviewKeys.has(interactionKey(interaction)),
  ));
  const policyReviewSubjects = new Map(plan.entries.flatMap((entry) => {
    const semantic = currentSemantics.get(entry.page_id);
    return semantic ? [[entry.page_id, semantic] as const] : [];
  }));
  const interactionCandidates = uniqueInteractionCandidates([
    ...buildInteractionCandidates(dataset, contentReviewRequired, deferred),
    ...(staleReviewModes.length > 0
      ? buildInteractionCandidates(dataset, policyReviewSubjects, deferred, staleReviewModes)
        .filter((candidate) => staleReviewKeys.has(candidate.review_id))
      : []),
  ]);
  const reviews = await reviewInteractionGroups({
    groups: judgementGroups(
      interactionCandidates,
      dataset.analysisPolicy.review.batch_size,
      plan.entries.every((entry) => entry.reason === 'catalog-expansion'),
    ),
    modelRunner,
    dataset,
    extracted: currentSemantics,
    deferred,
    plan,
    privateDirectory,
    runDirectory,
  });

  const activeCandidates = interactionCandidates.filter(
    (candidate) => !deferred.has(candidate.subject_page_id),
  );
  validateReviews(activeCandidates, reviews, currentSemantics, dataset);
  const proposedInteractions = reviewsToInteractions(
    activeCandidates,
    reviews,
    dataset,
    policyDigests,
  );
  for (const entry of plan.entries) {
    if (entry.reason !== 'catalog-expansion' || deferred.has(entry.page_id)) continue;
    if (!proposedInteractions.some(
      (interaction) =>
        interaction.verdict === 'accepted' && interaction.pages.includes(entry.page_id),
    )) {
      deferred.set(entry.page_id, 'No support A-C interaction with the existing dataset');
      finalized.delete(entry.page_id);
    }
  }

  const proposalData = await prepareProposalData(dataDirectory, runDirectory);
  const applied = await applyProposal({
    proposalData,
    dataset,
    plan,
    index,
    semantics: finalized,
    interactionKeys: new Set(activeCandidates.map((candidate) =>
      `${candidate.mode}:${candidate.left.page_id}:${candidate.right.page_id}`,
    )),
    interactions: proposedInteractions.filter((interaction) =>
      interaction.pages.every((pageId) => !deferred.has(pageId)),
    ),
  });
  for (const pageId of applied.skipped_pages) {
    deferred.set(pageId, 'Profile failed the public promotion gate');
    finalized.delete(pageId);
  }
  const promotedInteractions = applied.promoted;
  const proposedDataset = await loadDataset(proposalData);
  const validation = validateDataset(proposedDataset);
  if (!validation.valid) {
    throw new Error(`Proposed dataset validation failed:\n${validation.errors.join('\n')}`);
  }
  await buildArtifacts({
    dataDirectory: proposalData,
    outputDirectory: path.join(runDirectory, 'proposal', 'release'),
  });
  await writeJson(
    path.join(runDirectory, 'deferred.json'),
    Object.fromEntries(deferred),
  );
  const accepted = promotedInteractions.filter(
    (interaction) => interaction.verdict === 'accepted',
  ).length;
  const summary: MaintenanceRunSummary = {
    run_id: plan.run_id,
    dry_run: options.dryRun ?? false,
    analyzed: articles.map((article) => article.entry.page_id),
    proposed: [...finalized.keys()].sort(),
    deferred: [...deferred.keys()].sort(),
    accepted_interactions: accepted,
    rejected_interactions: promotedInteractions.length - accepted,
    proposal_directory: proposalData,
    validation: 'passed',
  };
  await writeJson(path.join(runDirectory, 'summary.json'), summary);
  await writeReviewPacket({
    runDirectory,
    plan,
    before: dataset,
    after: proposedDataset,
    reviews,
  });

  if (!(options.dryRun ?? false) && deferred.size > 0) {
    const state = await readState(privateDirectory);
    for (const [pageId, reason] of deferred) {
      const entry = plan.entries.find((item) => item.page_id === pageId)!;
      state.deferred[pageId] = {
        source_revision: entry.source_revision,
        catalog_count: plan.catalog_count,
        reason,
      };
    }
    state.catalog_count = plan.catalog_count;
    await writeState(privateDirectory, state);
  }
  return summary;
}

export async function writeLastRunStatus(
  privateDirectory: string,
  status: LastRunStatus,
): Promise<void> {
  await writeJson(path.join(privateDirectory, 'last-run.json'), status);
}

async function writeReviewPacket(options: {
  runDirectory: string;
  plan: MaintenancePlan;
  before: Dataset;
  after: Dataset;
  reviews?: JudgementReview[];
}): Promise<void> {
  const beforeProfiles = new Map(options.before.profiles.map((profile) => [profile.page_id, profile]));
  const afterProfiles = new Map(options.after.profiles.map((profile) => [profile.page_id, profile]));
  const beforeSemantics = new Map(options.before.semantics.map((semantic) => [semantic.page_id, semantic]));
  const afterSemantics = new Map(options.after.semantics.map((semantic) => [semantic.page_id, semantic]));
  const beforeInteractions = new Map(options.before.interactions.map((item) => [item.id, item]));
  const afterInteractions = new Map(options.after.interactions.map((item) => [item.id, item]));
  const beforeEngine = new IsorropiaEngine(options.before);
  const afterEngine = new IsorropiaEngine(options.after);
  const lines = [
    '# Maintenance review packet',
    '',
    `Run: ${options.plan.run_id}`,
    '',
  ];
  for (const entry of options.plan.entries) {
    const before = beforeProfiles.get(entry.page_id);
    const after = afterProfiles.get(entry.page_id);
    const oldClaims = new Set(beforeSemantics.get(entry.page_id)?.claims.map((claim) => claim.id) ?? []);
    const newClaims = new Set(afterSemantics.get(entry.page_id)?.claims.map((claim) => claim.id) ?? []);
    const addedClaims = [...newClaims].filter((claim) => !oldClaims.has(claim));
    const removedClaims = [...oldClaims].filter((claim) => !newClaims.has(claim));
    const interactionChanges = [...new Set([
      ...beforeInteractions.values(),
      ...afterInteractions.values(),
    ].filter((item) => item.pages.includes(entry.page_id)).map((item) => item.id))]
      .filter((id) => JSON.stringify(beforeInteractions.get(id)) !== JSON.stringify(afterInteractions.get(id)))
      .sort();
    lines.push(
      `## ${entry.page_id}`,
      '',
      `Source: ${after?.url ?? before?.url ?? `https://scp-wiki.wikidot.com/${entry.page_id}`}`,
      '',
      `Revision: ${before?.source_revision ?? 'new'} -> ${after?.source_revision ?? 'not promoted'}`,
      '',
      `Semantic claims: +${addedClaims.join(', ') || '-'}; -${removedClaims.join(', ') || '-'}`,
      '',
      `Interaction changes: ${interactionChanges.join(', ') || '-'}`,
      '',
    );
    for (const mode of MODES) {
      const previous = before
        ? beforeEngine.pair({ pageId: entry.page_id, mode }).results.map((item) => item.page_id)
        : [];
      const next = after
        ? afterEngine.pair({ pageId: entry.page_id, mode }).results.map((item) => item.page_id)
        : [];
      lines.push(`${mode}: ${previous.join(', ') || '-'} -> ${next.join(', ') || '-'}`);
    }
    const qualifications = options.after.interactions.flatMap((item) => {
      if (item.verdict !== 'accepted' || !item.pages.includes(entry.page_id)) return [];
      return [
        ...(item.assumption ? [`${item.id} assumption: ${item.assumption}`] : []),
        ...(item.limitation ? [`${item.id} limitation: ${item.limitation}`] : []),
      ];
    });
    lines.push('', ...(qualifications.length > 0 ? qualifications : ['Assumptions and limitations: -']), '');
  }
  const objections = (options.reviews ?? [])
    .filter((review) => review.verifier_objection?.trim())
    .map((review) => `${review.review_id}: ${review.verifier_objection!.trim()}`);
  if (objections.length > 0) {
    lines.push('## Verifier objections', '', ...objections, '');
  }
  await atomicWrite(path.join(options.runDirectory, 'review-packet.md'), `${lines.join('\n')}\n`);
}

export async function verifyMaintenanceRun(options: {
  runId: string;
  dataDirectory?: string;
  privateDirectory?: string;
  fetchImpl?: typeof fetch;
  checkSource?: boolean;
}): Promise<{ valid: true; changed_paths: string[] }> {
  const dataDirectory = options.dataDirectory ?? defaultDataDirectory();
  const privateDirectory = options.privateDirectory ?? defaultPrivateDirectory();
  const runDirectory = path.join(privateDirectory, 'runs', options.runId);
  const proposalData = path.join(runDirectory, 'proposal', 'data');
  const plan = await readJson<MaintenancePlan>(path.join(runDirectory, 'plan.json'));
  const dataset = await loadDataset(proposalData);
  const result = validateDataset(dataset);
  if (!result.valid) {
    throw new Error(`Proposed dataset validation failed:\n${result.errors.join('\n')}`);
  }
  if (options.checkSource ?? true) {
    const index = await fetchItemsIndex(options.fetchImpl);
    for (const entry of plan.entries) {
      if (sourceRevision(sourceEntry(index, entry.page_id)) !== entry.source_revision) {
        throw new Error(`Source revision changed after analysis: ${entry.page_id}`);
      }
    }
  }
  const changedPaths = await changedPublicDataPaths(dataDirectory, proposalData);
  await assertPublicDataDiffSafe(proposalData, changedPaths);
  await buildArtifacts({
    dataDirectory: proposalData,
    outputDirectory: path.join(runDirectory, 'verified-release'),
  });
  return { valid: true, changed_paths: changedPaths };
}

export async function applyMaintenanceRun(options: {
  runId: string;
  dataDirectory?: string;
  privateDirectory?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ applied: true; changed_paths: string[] }> {
  const dataDirectory = options.dataDirectory ?? defaultDataDirectory();
  const privateDirectory = options.privateDirectory ?? defaultPrivateDirectory();
  const verified = await verifyMaintenanceRun({
    runId: options.runId,
    dataDirectory,
    privateDirectory,
    fetchImpl: options.fetchImpl,
    checkSource: true,
  });
  const proposalData = path.join(
    privateDirectory,
    'runs',
    options.runId,
    'proposal',
    'data',
  );
  await copyVerifiedDataFiles(proposalData, dataDirectory, verified.changed_paths);
  return { applied: true, changed_paths: verified.changed_paths };
}

export async function publishMaintenanceRun(options: {
  runId: string;
  repositoryDirectory?: string;
  dataDirectory?: string;
  privateDirectory?: string;
  fetchImpl?: typeof fetch;
  commandRunner?: CommandRunner;
}): Promise<{ published: boolean; pr_url?: string; changed_paths: string[] }> {
  const repositoryDirectory = options.repositoryDirectory ?? path.resolve('.');
  const dataDirectory = options.dataDirectory ?? path.join(repositoryDirectory, 'data');
  const privateDirectory = options.privateDirectory ?? defaultPrivateDirectory();
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const status = await commandRunner('git', ['status', '--porcelain'], repositoryDirectory);
  if (status.stdout.trim()) {
    throw new Error('Publish requires a clean dedicated checkout');
  }
  const currentBranch = await commandRunner(
    'git',
    ['branch', '--show-current'],
    repositoryDirectory,
  );
  if (currentBranch.stdout.trim() !== 'main') {
    throw new Error('Publish requires the main branch');
  }
  await commandRunner('git', ['fetch', 'origin', 'main'], repositoryDirectory);
  const localHead = await commandRunner('git', ['rev-parse', 'HEAD'], repositoryDirectory);
  const remoteHead = await commandRunner(
    'git',
    ['rev-parse', 'origin/main'],
    repositoryDirectory,
  );
  if (localHead.stdout.trim() !== remoteHead.stdout.trim()) {
    throw new Error('Publish requires main to match origin/main; rerun the analysis');
  }
  const verified = await verifyMaintenanceRun({
    runId: options.runId,
    dataDirectory,
    privateDirectory,
    fetchImpl: options.fetchImpl,
    checkSource: true,
  });
  if (verified.changed_paths.length === 0) {
    return { published: false, changed_paths: [] };
  }
  const proposalData = path.join(
    privateDirectory,
    'runs',
    options.runId,
    'proposal',
    'data',
  );
  await copyVerifiedDataFiles(proposalData, dataDirectory, verified.changed_paths);
  const after = await commandRunner('git', ['status', '--porcelain'], repositoryDirectory);
  const actualPaths = parseStatusPaths(after.stdout);
  if (actualPaths.some((item) => !verified.changed_paths.includes(item))) {
    throw new Error(`Publish changed a non-allowlisted path: ${actualPaths.join(', ')}`);
  }
  const branch = `bot/qualitative-refresh-${options.runId}`;
  let phase = 'branch';
  let commitSucceeded = false;
  try {
    await commandRunner('git', ['switch', '-c', branch], repositoryDirectory);
    phase = 'stage';
    await commandRunner('git', ['add', '--', ...verified.changed_paths], repositoryDirectory);
    phase = 'commit';
    await commandRunner(
      'git',
      ['commit', '-m', 'data: refresh qualitative SCP profiles'],
      repositoryDirectory,
    );
    commitSucceeded = true;
    phase = 'push';
    await commandRunner('git', ['push', '--set-upstream', 'origin', branch], repositoryDirectory);
    const summary = await readJson<MaintenanceRunSummary>(
      path.join(privateDirectory, 'runs', options.runId, 'summary.json'),
    );
    const body = [
      `Analyzed: ${summary.analyzed.length}`,
      `Profiles updated: ${summary.proposed.length}`,
      `Interactions accepted: ${summary.accepted_interactions}`,
      `Interactions rejected: ${summary.rejected_interactions}`,
      'Validation: passed',
    ].join('\n');
    phase = 'draft-pr';
    const pr = await commandRunner(
      'gh',
      [
        'pr', 'create', '--draft', '--base', 'main', '--head', branch,
        '--title', 'data: refresh qualitative SCP profiles', '--body', body,
      ],
      repositoryDirectory,
    );
    const prUrl = pr.stdout.trim().split(/\s+/).find((item) => /^https:\/\//.test(item));
    if (!prUrl) throw new Error('Draft PR was created but no URL was returned');
    const plan = await readJson<MaintenancePlan>(
      path.join(privateDirectory, 'runs', options.runId, 'plan.json'),
    );
    const state = await readState(privateDirectory);
    for (const pageId of summary.proposed) {
      const entry = plan.entries.find((item) => item.page_id === pageId);
      if (!entry) continue;
      state.pending[pageId] = {
        source_revision: entry.source_revision,
        catalog_count: plan.catalog_count,
        run_id: options.runId,
        pr_url: prUrl,
      };
    }
    state.catalog_count = plan.catalog_count;
    await writeState(privateDirectory, state);
    return { published: true, pr_url: prUrl, changed_paths: verified.changed_paths };
  } catch (error) {
    await writeJson(
      path.join(privateDirectory, 'runs', options.runId, 'publish-recovery.json'),
      {
        version: 1,
        run_id: options.runId,
        phase,
        branch,
        commit_created: commitSucceeded,
        changed_paths: verified.changed_paths,
        error: errorMessage(error),
      },
    );
    throw error;
  } finally {
    if (commitSucceeded) {
      await commandRunner('git', ['switch', 'main'], repositoryDirectory);
    }
  }
}

async function copyVerifiedDataFiles(
  proposalData: string,
  dataDirectory: string,
  changedPaths: string[],
): Promise<void> {
  for (const relativePath of changedPaths) {
    if (!isAllowedPublicDataPath(relativePath)) {
      throw new Error(`Non-allowlisted public path: ${relativePath}`);
    }
    const dataRelative = relativePath.slice('data/'.length);
    const target = path.join(dataDirectory, dataRelative);
    await mkdir(path.dirname(target), { recursive: true });
    await atomicWrite(target, await readFile(path.join(proposalData, dataRelative), 'utf8'));
  }
}

export async function assertPublicDataDiffSafe(
  proposalDataDirectory: string,
  changedPaths: string[],
): Promise<void> {
  for (const relativePath of changedPaths) {
    if (!isAllowedPublicDataPath(relativePath)) {
      throw new Error(`Non-allowlisted public path: ${relativePath}`);
    }
    const content = await readFile(
      path.join(proposalDataDirectory, relativePath.slice('data/'.length)),
      'utf8',
    );
    const forbidden = [
      /(?:^|[^\w])\.private(?:[\\/]|$)/i,
      /\/home\/[a-z0-9._-]+\//i,
      /\/Users\/[a-z0-9._-]+\//i,
      /[A-Z]:\\Users\\[^\\]+\\/i,
      /\bsk-[A-Za-z0-9_-]{20,}\b/,
      /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    ].find((pattern) => pattern.test(content));
    if (forbidden) {
      throw new Error(`Private material detected in ${relativePath}`);
    }
  }
}

function eligibleCatalogEntries(
  index: Record<string, SourceIndexEntry>,
  policy: SelectionPolicy,
  now: Date,
): Array<{ pageId: string; source: SourceIndexEntry }> {
  const oldestAllowed = now.getTime() - policy.eligibility.minimum_age_days * 86_400_000;
  return Object.entries(index).flatMap(([key, source]) => {
    const match = /^SCP-(\d{3,})$/.exec(key);
    if (!match) return [];
    const pageId = `scp-${match[1]}`;
    let sourceUrl: URL;
    try {
      sourceUrl = new URL(source.url ?? '');
    } catch {
      return [];
    }
    const createdAt = Date.parse(source.created_at ?? '');
    if (
      sourceUrl.hostname !== policy.eligibility.domain ||
      !(source.tags ?? []).includes(policy.eligibility.required_tag) ||
      (source.rating ?? -Infinity) < policy.eligibility.minimum_rating ||
      !Number.isFinite(createdAt) ||
      createdAt > oldestAllowed ||
      !source.content_file ||
      !String(source.page_id ?? '').trim() ||
      !(source.creator ?? source.created_by ?? '').trim()
    ) return [];
    return [{ pageId, source }];
  });
}

async function cachedExtraction(options: {
  modelRunner: QualitativeModelRunner;
  chunks: ArticleChunk[];
  ontology: Dataset['semanticOntology'];
  privateDirectory: string;
  runDirectory: string;
}): Promise<ExtractedSemanticProfile[]> {
  const cachePath = modelCheckpointPath(
    options.privateDirectory,
    'extraction-batch',
    {
      model: EXTRACTION_MODEL,
      contract: qualitativeContractDigests().extraction,
      ontology: options.ontology,
      chunks: options.chunks,
    },
  );
  const cached = await readModelCheckpoint<ExtractedSemanticProfile[]>(cachePath);
  if (cached) {
    try {
      const normalized = normalizeChunkReceipts(cached, options.chunks);
      validateChunkExtraction(normalized, options.chunks);
      return normalized;
    } catch {
      // Policy-keyed cache entries from an interrupted run are regenerated.
    }
  }
  const profiles = normalizeChunkReceipts(await options.modelRunner.extract(
    options.chunks,
    options.runDirectory,
    options.ontology,
  ), options.chunks);
  validateChunkExtraction(profiles, options.chunks);
  await writeModelCheckpoint(cachePath, profiles);
  return profiles;
}

async function validatedArticleExtraction(options: {
  modelRunner: QualitativeModelRunner;
  chunks: ArticleChunk[];
  article: LoadedArticle;
  ontology: Dataset['semanticOntology'];
  privateDirectory: string;
  runDirectory: string;
}): Promise<ExtractedSemanticProfile> {
  const cachePath = modelCheckpointPath(
    options.privateDirectory,
    'extraction-article',
    {
      model: EXTRACTION_MODEL,
      contract: qualitativeContractDigests().extraction,
      ontology: options.ontology,
      chunks: options.chunks,
    },
  );
  const cached = await readModelCheckpoint<ExtractedSemanticProfile[]>(cachePath);
  if (cached) {
    try {
      return mergeAndValidateArticleProfiles(cached, options.article);
    } catch {
      // Ignore an invalid private checkpoint and regenerate only this article.
    }
  }
  const profiles = normalizeChunkReceipts(await options.modelRunner.extract(
    options.chunks,
    options.runDirectory,
    options.ontology,
  ), options.chunks);
  validateChunkExtraction(profiles, options.chunks);
  let semantic: ExtractedSemanticProfile;
  if (options.modelRunner.consolidate) {
    try {
      const consolidated = await options.modelRunner.consolidate(
        profiles,
        options.chunks,
        options.runDirectory,
        options.ontology,
      );
      semantic = mergeAndValidateArticleProfiles([consolidated], options.article);
    } catch {
      semantic = mergeAndValidateArticleProfiles(profiles, options.article);
    }
  } else {
    semantic = mergeAndValidateArticleProfiles(profiles, options.article);
  }
  await writeModelCheckpoint(cachePath, profiles);
  return semantic;
}

function validateChunkExtraction(
  profiles: ExtractedSemanticProfile[],
  chunks: ArticleChunk[],
): void {
  const expected = new Set(chunks.map((chunk) => `${chunk.page_id}:${chunk.chunk_id}`));
  const seen = new Set<string>();
  for (const profile of profiles) {
    const key = `${profile.page_id}:${profile.extraction_chunk_id ?? ''}`;
    if (!expected.has(key) || seen.has(key)) {
      throw new Error(`Unexpected or duplicate semantic chunk: ${key}`);
    }
    seen.add(key);
  }
  if (seen.size !== expected.size) {
    const missing = [...expected].filter((key) => !seen.has(key));
    throw new Error(`Model omitted semantic chunks: ${missing.join(', ')}`);
  }
}

function normalizeChunkReceipts(
  profiles: ExtractedSemanticProfile[],
  chunks: ArticleChunk[],
): ExtractedSemanticProfile[] {
  const expectedByPage = new Map<string, string[]>();
  const profileCounts = new Map<string, number>();
  for (const chunk of chunks) {
    const values = expectedByPage.get(chunk.page_id) ?? [];
    values.push(chunk.chunk_id);
    expectedByPage.set(chunk.page_id, values);
  }
  for (const profile of profiles) {
    profileCounts.set(profile.page_id, (profileCounts.get(profile.page_id) ?? 0) + 1);
  }
  return profiles.map((profile) => {
    const expected = expectedByPage.get(profile.page_id);
    if (expected?.length !== 1 || profileCounts.get(profile.page_id) !== 1) return profile;
    const [chunkId] = expected;
    return {
      ...profile,
      extraction_chunk_id: chunkId,
      claims: profile.claims.map((claim) => ({
        ...claim,
        chunk_ids: [chunkId!],
      })),
      ...(profile.reading ? {
        reading: {
          ...profile.reading,
          moves: profile.reading.moves?.map((move) => ({
            ...move,
            chunk_ids: [chunkId!],
          })),
        },
      } : {}),
    };
  });
}

function mergeAndValidateArticleProfiles(
  profiles: ExtractedSemanticProfile[],
  article: LoadedArticle,
): ExtractedSemanticProfile {
  const merged = new Map<string, ExtractedSemanticProfile>();
  mergeExtractionBatch(merged, profiles);
  const semantic = merged.get(article.entry.page_id);
  if (!semantic || merged.size !== 1) {
    throw new Error(`Model omitted semantic profile during repair: ${article.entry.page_id}`);
  }
  const grounded = retainSourceGroundedContent(
    repairEvidenceLocators(semantic, article),
    article,
  );
  validateGeneratedSemantic(grounded, article);
  return grounded;
}

function mergeExtractionBatch(
  target: Map<string, ExtractedSemanticProfile>,
  profiles: ExtractedSemanticProfile[],
): void {
  for (const profile of profiles) {
    const existing = target.get(profile.page_id);
    if (!existing) {
      target.set(profile.page_id, profile);
      continue;
    }
    if (existing.source_revision !== profile.source_revision) {
      throw new Error(`Conflicting semantic revisions: ${profile.page_id}`);
    }
    const claimIds = new Set(existing.claims.map((claim) => claim.id));
    for (const claim of profile.claims) {
      let id = claim.id;
      let suffix = 2;
      while (claimIds.has(id)) id = `${claim.id}-${suffix++}`;
      claimIds.add(id);
      existing.claims.push({ ...claim, id });
    }
    if (profile.reading) {
      existing.reading = mergeReading(existing.reading, profile.reading);
    }
  }
}

function normalizeEvidenceSections(profile: SemanticProfile): SemanticProfile {
  return {
    ...profile,
    claims: profile.claims.map((claim) => ({
      ...claim,
      evidence: claim.evidence.map((evidence) => ({
        ...evidence,
        section: evidence.section.trim() || 'Article source',
      })),
    })),
    ...(profile.reading ? {
      reading: {
        ...profile.reading,
        moves: profile.reading.moves?.map((move) => ({
          ...move,
          evidence: move.evidence.map((evidence) => ({
            ...evidence,
            section: evidence.section.trim() || 'Article source',
          })),
        })),
      },
    } : {}),
  };
}

function finalizeSemanticProfile(
  semantic: ExtractedSemanticProfile,
  article: LoadedArticle,
  dataset: Dataset,
  semanticPolicyDigest: string,
): SemanticProfile {
  const chunks = articleChunks(article);
  const chunkIds = chunks.map((chunk) => chunk.chunk_id);
  const groundedChunkIds = (
    supplied: string[],
    evidence: SemanticClaim['evidence'],
  ): string[] => {
    const resolved = supplied.filter((id) => chunkIds.includes(id));
    for (const item of evidence) {
      const locator = normalizeWhitespace(item.locator);
      const found = chunks.find((chunk) =>
        normalizedEvidenceSources(chunk.source).some((source) => source.includes(locator)));
      if (found && !resolved.includes(found.chunk_id)) resolved.push(found.chunk_id);
    }
    return resolved.sort();
  };
  const claims = semantic.claims.map((claim) => {
    if (
      !claim.role || !dataset.semanticOntology.claim_roles.includes(claim.role) ||
      !claim.operation_class || !(claim.operation_class in dataset.semanticOntology.operations) ||
      !claim.domain_class || !(claim.domain_class in dataset.semanticOntology.domains) ||
      !claim.affected_state || !(claim.affected_state in dataset.semanticOntology.affected_states) ||
      !claim.direction || !dataset.semanticOntology.directions.includes(claim.direction)
    ) {
      throw new Error(`Generated claim has invalid ontology values: ${semantic.page_id}/${claim.id}`);
    }
    return {
      ...claim,
      role: claim.role,
      operation_class: claim.operation_class,
      domain_class: claim.domain_class,
      affected_state: claim.affected_state,
      direction: claim.direction,
      chunk_ids: groundedChunkIds(claim.chunk_ids, claim.evidence),
    };
  });
  return {
    page_id: semantic.page_id,
    source_revision: semantic.source_revision,
    schema_version: 2,
    claims,
    ...(semantic.reading ? {
      reading: {
        ...semantic.reading,
        moves: semantic.reading.moves?.map((move) => ({
          ...move,
          chunk_ids: groundedChunkIds(move.chunk_ids, move.evidence),
        })),
      },
    } : {}),
    coverage: {
      status: article.coverage,
      source_digest: article.source_digest,
      analyzed_chunk_ids: chunkIds,
      unresolved_features: article.unresolved_features,
    },
    semantic_policy_digest: semanticPolicyDigest,
    reviewed_modes: [...MODES],
  };
}

function validateGeneratedSemantic(
  semantic: ExtractedSemanticProfile,
  article: LoadedArticle,
): void {
  if (semantic.page_id !== article.entry.page_id) {
    throw new Error(`Semantic page mismatch: ${semantic.page_id}`);
  }
  if (semantic.source_revision !== article.entry.source_revision) {
    throw new Error(`Semantic revision mismatch: ${semantic.page_id}`);
  }
  if (semantic.claims.length === 0) {
    throw new Error(`Semantic profile has no claims: ${semantic.page_id}`);
  }
  const evidenceSources = normalizedEvidenceSources(article.normalized_source);
  const validateEvidence = (evidence: SemanticClaim['evidence'][number], context: string): void => {
    if (evidence.revision !== semantic.source_revision) {
      throw new Error(`Generated evidence revision mismatch: ${semantic.page_id}/${context}`);
    }
    if (!isExactGeneratedEvidence(evidence, semantic.source_revision, evidenceSources)) {
      throw new Error(`Generated evidence is not an exact source excerpt: ${semantic.page_id}/${context}`);
    }
  };
  const claimIds = new Set<string>();
  for (const claim of semantic.claims) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(claim.id) || claimIds.has(claim.id)) {
      throw new Error(`Invalid generated claim ID: ${semantic.page_id}/${claim.id}`);
    }
    claimIds.add(claim.id);
    for (const evidence of claim.evidence) validateEvidence(evidence, claim.id);
  }
  for (const [index, move] of (semantic.reading?.moves ?? []).entries()) {
    for (const evidence of move.evidence) {
      validateEvidence(evidence, `reading-${move.kind}-${index + 1}`);
    }
  }
}

export function retainSourceGroundedContent(
  semantic: ExtractedSemanticProfile,
  article: LoadedArticle,
): ExtractedSemanticProfile {
  const sources = normalizedEvidenceSources(article.normalized_source);
  const grounded = (evidence: SemanticClaim['evidence'][number]): boolean =>
    isExactGeneratedEvidence(evidence, semantic.source_revision, sources);
  return {
    ...semantic,
    claims: semantic.claims.filter((claim) =>
      claim.evidence.length > 0 && claim.evidence.every(grounded)),
    ...(semantic.reading ? {
      reading: {
        ...semantic.reading,
        moves: semantic.reading.moves?.filter((move) =>
          move.evidence.length > 0 && move.evidence.every(grounded)),
      },
    } : {}),
  };
}

function isExactGeneratedEvidence(
  evidence: SemanticClaim['evidence'][number],
  revision: number,
  sources: string[],
): boolean {
  const locator = normalizeWhitespace(evidence.locator);
  return evidence.revision === revision && locator.length >= 12 &&
    sources.some((source) => source.includes(locator));
}

function repairEvidenceLocators(
  semantic: ExtractedSemanticProfile,
  article: LoadedArticle,
): ExtractedSemanticProfile {
  const sources = normalizedEvidenceSources(article.normalized_source);
  const repair = (evidence: SemanticClaim['evidence'][number]) => ({
    ...evidence,
    locator: exactSourceLocator(evidence.locator, sources),
  });
  return {
    ...semantic,
    claims: semantic.claims.map((claim) => ({
      ...claim,
      evidence: claim.evidence.map(repair),
    })),
    ...(semantic.reading ? {
      reading: {
        ...semantic.reading,
        moves: semantic.reading.moves?.map((move) => ({
          ...move,
          evidence: move.evidence.map(repair),
        })),
      },
    } : {}),
  };
}

function normalizedEvidenceSources(source: string): string[] {
  const withoutFootnotes = source.replace(
    /\[\[footnote\]\][\s\S]*?\[\[\/footnote\]\]/gi,
    '',
  );
  return [...new Set([
    source,
    withoutFootnotes,
    normalizeWikidotDisplayText(source),
    normalizeWikidotDisplayText(withoutFootnotes),
  ].map(normalizeWhitespace))];
}

function exactSourceLocator(locator: string, sources: string[]): string {
  const normalized = normalizeWhitespace(locator);
  if (sources.some((source) => source.includes(normalized))) return normalized;
  const needle = normalized.toLocaleLowerCase('en-US');
  const matches: string[] = [];
  for (const source of sources) {
    const haystack = source.toLocaleLowerCase('en-US');
    if (haystack.length !== source.length || needle.length !== normalized.length) continue;
    const first = haystack.indexOf(needle);
    if (first < 0 || haystack.indexOf(needle, first + 1) >= 0) continue;
    matches.push(source.slice(first, first + normalized.length));
  }
  return [...new Set(matches)].length === 1 ? matches[0]! : locator;
}

async function runInteractionReview(
  modelRunner: QualitativeModelRunner,
  candidates: InteractionCandidate[],
  runDirectory: string,
): Promise<JudgementReview[]> {
  const proposals = await modelRunner.propose(candidates, runDirectory);
  return verifyAcceptedProposals(modelRunner, candidates, proposals, runDirectory);
}

function uniqueInteractionCandidates(
  candidates: InteractionCandidate[],
): InteractionCandidate[] {
  return [...new Map(candidates.map((candidate) => [
    candidate.review_id,
    candidate,
  ])).values()];
}

async function reviewInteractionGroups(options: {
  groups: InteractionCandidate[][];
  modelRunner: QualitativeModelRunner;
  dataset: Dataset;
  extracted: Map<string, SemanticProfile>;
  deferred: Map<string, string>;
  plan: MaintenancePlan;
  privateDirectory: string;
  runDirectory: string;
}): Promise<JudgementReview[]> {
  const reviews: JudgementReview[] = [];
  const pending: InteractionCandidate[][] = [];
  for (const group of options.groups) {
    const cached = await readValidatedJudgementCheckpoint({
      candidates: group,
      dataset: options.dataset,
      extracted: options.extracted,
      privateDirectory: options.privateDirectory,
    });
    if (cached) reviews.push(...cached);
    else pending.push(group);
  }
  if (pending.length === 0) return reviews;

  for (
    let offset = 0;
    offset < pending.length;
    offset += MAX_CONCURRENT_JUDGEMENTS
  ) {
    const concurrent = pending.slice(offset, offset + MAX_CONCURRENT_JUDGEMENTS);
    const results = await Promise.all(concurrent.map(async (group) => {
      const pageId = group[0]!.subject_page_id;
      const entry = options.plan.entries.find((item) => item.page_id === pageId)!;
      try {
        const normalized = normalizeInteractionReviews(
          group,
          await runInteractionReview(options.modelRunner, group, options.runDirectory),
        );
        const groupReviews = rejectInvalidAcceptedReviews(
          group,
          normalized,
          options.extracted,
          options.dataset,
        );
        validateReviews(group, groupReviews, options.extracted, options.dataset);
        await writeJudgementCheckpoint(
          options.privateDirectory,
          group,
          groupReviews,
        );
        return { reviews: groupReviews };
      } catch (error) {
        if (entry.reason !== 'catalog-expansion') return { error };
        options.deferred.set(pageId, errorMessage(error));
        options.extracted.delete(pageId);
        return { reviews: [] };
      }
    }));
    for (const result of results) {
      if (result.error) throw result.error;
      reviews.push(...(result.reviews ?? []));
    }
  }
  return reviews;
}

async function readValidatedJudgementCheckpoint(options: {
  candidates: InteractionCandidate[];
  dataset: Dataset;
  extracted: Map<string, SemanticProfile>;
  privateDirectory: string;
}): Promise<JudgementReview[] | undefined> {
  const cachePath = judgementCheckpointPath(options.privateDirectory, options.candidates);
  const cached = await readModelCheckpoint<JudgementReview[]>(cachePath);
  if (!cached) return undefined;
  try {
    const normalized = rejectInvalidAcceptedReviews(
      options.candidates,
      normalizeInteractionReviews(options.candidates, cached),
      options.extracted,
      options.dataset,
    );
    validateReviews(options.candidates, normalized, options.extracted, options.dataset);
    return normalized;
  } catch {
    return undefined;
  }
}

async function writeJudgementCheckpoint(
  privateDirectory: string,
  candidates: InteractionCandidate[],
  reviews: JudgementReview[],
): Promise<void> {
  await writeModelCheckpoint(judgementCheckpointPath(privateDirectory, candidates), reviews);
}

function judgementCheckpointPath(
  privateDirectory: string,
  candidates: InteractionCandidate[],
): string {
  const mode = candidates[0]?.mode;
  if (!mode || candidates.some((candidate) => candidate.mode !== mode)) {
    throw new Error('Judgement checkpoints require a single mode');
  }
  return modelCheckpointPath(
    privateDirectory,
    'judgement-subject',
    {
      model: JUDGEMENT_MODEL,
      contract: qualitativeReviewContractDigest(mode),
      candidates,
    },
  );
}

async function prepareProposalData(
  dataDirectory: string,
  runDirectory: string,
): Promise<string> {
  const proposalData = path.join(runDirectory, 'proposal', 'data');
  await mkdir(path.dirname(proposalData), { recursive: true });
  try {
    await stat(proposalData);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await cp(dataDirectory, proposalData, { recursive: true });
  }
  return proposalData;
}

async function applyProposal(options: {
  proposalData: string;
  dataset: Dataset;
  plan: MaintenancePlan;
  index: Record<string, SourceIndexEntry>;
  semantics: Map<string, SemanticProfile>;
  interactionKeys: Set<string>;
  interactions: PairInteraction[];
}): Promise<{ promoted: PairInteraction[]; skipped_pages: string[] }> {
  const profiles = new Map(options.dataset.profiles.map((profile) => [profile.page_id, profile]));
  const curation = await readJson<CurationEntry[]>(path.join(options.proposalData, 'curation.json'));
  let edges = [...options.dataset.edges];
  const semanticById = new Map(options.dataset.semantics.map((item) => [item.page_id, item]));
  let curationChanged = false;
  let edgesChanged = false;
  const changedProfiles = new Map<string, Profile>();
  const skippedPages = new Set<string>();
  for (const [pageId, semantic] of options.semantics) {
    const normalizedSemantic = normalizeEvidenceSections(semantic);
    semanticById.set(pageId, normalizedSemantic);
    const planEntryValue = options.plan.entries.find((entry) => entry.page_id === pageId)!;
    const source = sourceEntry(options.index, pageId);
    const existing = profiles.get(pageId);
    const profile = profileFromSemantic(
      pageId,
      source,
      normalizedSemantic,
      options.dataset.semanticOntology,
      existing,
    );
    if (
      planEntryValue.reason === 'catalog-expansion' &&
      (profile.authors.length === 0 || profile.authors.includes('Unknown Author'))
    ) {
      semanticById.delete(pageId);
      skippedPages.add(pageId);
      continue;
    }
    profiles.set(pageId, profile);
    changedProfiles.set(pageId, profile);
    if (planEntryValue.reason === 'catalog-expansion') {
      curation.push(curationFromProfile(profile));
      curationChanged = true;
    } else {
      const index = curation.findIndex((entry) => entry.page_id === pageId);
      if (index < 0) throw new Error(`Missing curation entry for ${pageId}`);
      curation[index] = {
        ...curationFromProfile(profile),
        ...(curation[index]!.known_not ? { known_not: curation[index]!.known_not } : {}),
      };
      curationChanged = true;
    }
    edges = edges.filter((edge) => edge.from !== pageId);
    edgesChanged = true;
  }
  const selected = new Set(profiles.keys());
  for (const pageId of options.semantics.keys()) {
    if (skippedPages.has(pageId)) continue;
    const planEntryValue = options.plan.entries.find((entry) => entry.page_id === pageId)!;
    const source = sourceEntry(options.index, pageId);
    const revision = sourceRevision(source);
    for (const reference of source.references ?? []) {
      const target = normalizeReference(reference);
      if (!selected.has(target) || target === pageId) continue;
      edges.push({
        from: pageId,
        to: target,
        type: 'explicit_link',
        evidence: {
          revision,
          section: 'metadata.references',
          locator: `link:${target}`,
        },
      });
    }
  }
  const interactionByKey = new Map<string, PairInteraction>();
  for (const interaction of options.dataset.interactions) {
    if (options.interactionKeys.has(interactionKey(interaction))) continue;
    interactionByKey.set(interactionKey(interaction), {
      ...interaction,
      semantic_digests: Object.fromEntries(interaction.pages.map((pageId) => [
        pageId,
        interactionSemanticDigest(semanticById.get(pageId)!),
      ])),
    });
  }
  let profileValues = [...profiles.values()].sort(comparePageIds);
  let semanticValues = [...semanticById.values()].sort((a, b) => a.page_id.localeCompare(b.page_id));
  if (edgesChanged) edges = uniqueEdges(edges);
  let baseDataset: Dataset = {
    ...options.dataset,
    profiles: profileValues,
    semantics: semanticValues,
    edges,
    interactions: [...interactionByKey.values()],
  };
  let baseGoldenErrors = validateGoldenRankings(baseDataset);
  const expansions = options.plan.entries
    .filter((entry) => entry.reason === 'catalog-expansion' && profiles.has(entry.page_id))
    .sort((left, right) =>
      (left.selection_score ?? 0) - (right.selection_score ?? 0) ||
      right.page_id.localeCompare(left.page_id),
    );
  while (baseGoldenErrors.length > 0 && expansions.length > 0) {
    const skipped = expansions.shift()!;
    skippedPages.add(skipped.page_id);
    profiles.delete(skipped.page_id);
    semanticById.delete(skipped.page_id);
    changedProfiles.delete(skipped.page_id);
    const curationIndex = curation.findIndex((entry) => entry.page_id === skipped.page_id);
    if (curationIndex >= 0) curation.splice(curationIndex, 1);
    edges = edges.filter((edge) =>
      edge.from !== skipped.page_id && edge.to !== skipped.page_id,
    );
    profileValues = [...profiles.values()].sort(comparePageIds);
    semanticValues = [...semanticById.values()].sort((a, b) => a.page_id.localeCompare(b.page_id));
    baseDataset = {
      ...baseDataset,
      profiles: profileValues,
      semantics: semanticValues,
      edges,
    };
    baseGoldenErrors = validateGoldenRankings(baseDataset);
  }
  const proposedInteractions = [...options.interactions]
    .filter((item) => item.pages.every((pageId) => profiles.has(pageId)))
    .sort(compareInteractionQuality);
  let promoted: PairInteraction[] = [];
  const batchInteractions = new Map(interactionByKey);
  for (const interaction of proposedInteractions) {
    batchInteractions.set(interactionKey(interaction), interaction);
  }
  const batchGoldenErrors = validateGoldenRankings({
    ...baseDataset,
    interactions: [...batchInteractions.values()],
  });
  if (batchGoldenErrors.length === 0) {
    interactionByKey.clear();
    for (const [key, interaction] of batchInteractions) interactionByKey.set(key, interaction);
    promoted = proposedInteractions;
  } else {
    for (const interaction of proposedInteractions) {
      const key = interactionKey(interaction);
      const previous = interactionByKey.get(key);
      interactionByKey.set(key, interaction);
      const candidateDataset = {
        ...baseDataset,
        interactions: [...interactionByKey.values()],
      };
      const candidateGoldenErrors = validateGoldenRankings(candidateDataset);
      const preservesExistingGoldenCases = candidateGoldenErrors.every((error) =>
        baseGoldenErrors.includes(error));
      if (
        preservesExistingGoldenCases &&
        candidateGoldenErrors.length <= baseGoldenErrors.length
      ) {
        promoted.push(interaction);
        baseGoldenErrors = candidateGoldenErrors;
      } else if (previous) {
        interactionByKey.set(key, previous);
      } else {
        interactionByKey.delete(key);
      }
    }
    if (baseGoldenErrors.length > 0) {
      throw new Error(`Profile update regressed golden rankings:\n${baseGoldenErrors.join('\n')}`);
    }
  }
  for (const entry of options.plan.entries.filter(
    (item) => item.reason === 'catalog-expansion' && profiles.has(item.page_id),
  )) {
    const hasAccepted = promoted.some((interaction) =>
      interaction.verdict === 'accepted' && interaction.pages.includes(entry.page_id),
    );
    if (hasAccepted) continue;
    skippedPages.add(entry.page_id);
    profiles.delete(entry.page_id);
    semanticById.delete(entry.page_id);
    changedProfiles.delete(entry.page_id);
    const curationIndex = curation.findIndex((item) => item.page_id === entry.page_id);
    if (curationIndex >= 0) curation.splice(curationIndex, 1);
    edges = edges.filter((edge) =>
      edge.from !== entry.page_id && edge.to !== entry.page_id,
    );
    for (const [key, interaction] of interactionByKey) {
      if (interaction.pages.includes(entry.page_id)) interactionByKey.delete(key);
    }
    promoted = promoted.filter((interaction) => !interaction.pages.includes(entry.page_id));
  }
  profileValues = [...profiles.values()].sort(comparePageIds);
  semanticValues = [...semanticById.values()].sort((a, b) => a.page_id.localeCompare(b.page_id));
  const interactionValues = [...interactionByKey.values()].sort((a, b) => a.id.localeCompare(b.id));
  curationChanged = curationChanged && changedProfiles.size > 0;
  edgesChanged = edgesChanged && changedProfiles.size > 0;
  for (const [pageId, profile] of changedProfiles) {
    await writeJson(path.join(options.proposalData, 'profiles', `${pageId}.json`), profile);
  }
  if (curationChanged) {
    await writeJson(
      path.join(options.proposalData, 'curation.json'),
      curation.sort((a, b) => a.page_id.localeCompare(b.page_id)),
    );
  }
  const databaseVersion = calculateDatabaseVersion({
    profiles: profileValues,
    edges,
    semantics: semanticValues,
    interactions: interactionValues,
    semanticOntology: options.dataset.semanticOntology,
    analysisPolicy: options.dataset.analysisPolicy,
  });
  const dataChanged = databaseVersion !== options.dataset.manifest.database_version;
  if (dataChanged) {
    await writeJson(path.join(options.proposalData, 'semantics.json'), semanticValues);
    await writeJson(path.join(options.proposalData, 'interactions.json'), interactionValues);
  }
  if (edgesChanged) {
    await atomicWrite(
      path.join(options.proposalData, 'edges.jsonl'),
      `${edges.map((edge) => JSON.stringify(edge)).join('\n')}\n`,
    );
  }
  const manifest = {
    database_version: databaseVersion,
    generated_at: dataChanged
      ? new Date().toISOString()
      : options.dataset.manifest.generated_at,
    source: options.dataset.manifest.source,
    profile_count: profileValues.length,
    attributions: profileValues.map((profile) => ({
      page_id: profile.page_id,
      title: profile.title,
      url: profile.url,
      authors: profile.authors,
      revision: profile.source_revision,
      license: 'CC BY-SA 3.0' as const,
      status: profile.authors.length === 0 || profile.authors.includes('Unknown Author')
        ? 'unresolved' as const
        : 'verified' as const,
    })),
  };
  await writeJson(path.join(options.proposalData, 'manifest.json'), manifest);
  return { promoted, skipped_pages: [...skippedPages].sort() };
}

function profileFromSemantic(
  pageId: string,
  source: SourceIndexEntry,
  semantic: SemanticProfile,
  ontology: Dataset['semanticOntology'],
  existing?: Profile,
): Profile {
  const effects = compileProfileEffects(semantic, ontology);
  const creator = (source.creator ?? source.created_by ?? '').trim();
  return {
    page_id: pageId,
    scp_number: Number(pageId.slice(4)),
    wikidot_page_id: String(source.page_id ?? ''),
    title: source.title ?? pageId.toUpperCase(),
    url: source.url ?? `https://scp-wiki.wikidot.com/${pageId}`,
    authors: existing?.authors.length ? existing.authors : creator ? [creator] : [],
    language: 'en',
    source_revision: sourceRevision(source),
    ...(source.series ? { series: source.series } : {}),
    tags: [...new Set(source.tags ?? [])].sort(),
    themes: compileReadingThemes(semantic.reading),
    effects,
    ...(existing?.known_not ? { known_not: existing.known_not } : {}),
    curated: true,
  };
}

function curationFromProfile(profile: Profile): CurationEntry {
  return {
    page_id: profile.page_id,
    ...(profile.known_not ? { known_not: profile.known_not } : {}),
  };
}

async function changedPublicDataPaths(
  currentData: string,
  proposalData: string,
): Promise<string[]> {
  const candidates = new Set<string>(PUBLIC_DATA_PATHS);
  const profileNames = new Set<string>();
  for (const directory of [path.join(currentData, 'profiles'), path.join(proposalData, 'profiles')]) {
    for (const name of await readdir(directory)) {
      if (name.endsWith('.json')) profileNames.add(name);
    }
  }
  for (const name of profileNames) candidates.add(`data/profiles/${name}`);
  const changed: string[] = [];
  for (const relativePath of [...candidates].sort()) {
    const dataRelative = relativePath.slice('data/'.length);
    const [left, right] = await Promise.all([
      readFileIfPresent(path.join(currentData, dataRelative)),
      readFileIfPresent(path.join(proposalData, dataRelative)),
    ]);
    if (!buffersEqual(left, right)) changed.push(relativePath);
  }
  return changed;
}

function isAllowedPublicDataPath(relativePath: string): boolean {
  return PUBLIC_DATA_PATHS.includes(relativePath as typeof PUBLIC_DATA_PATHS[number]) ||
    /^data\/profiles\/scp-\d{3,}\.json$/.test(relativePath);
}

function parseStatusPaths(output: string): string[] {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).trim().replace(/^"|"$/g, ''));
}

function sourceEntry(
  index: Record<string, SourceIndexEntry>,
  pageId: string,
): SourceIndexEntry {
  const entry = index[normalizedSourceKey(pageId)];
  if (!entry) throw new Error(`SCP Data API has no entry for ${pageId}`);
  return entry;
}

function planEntry(pageId: string, source: SourceIndexEntry): Omit<MaintenancePlanEntry, 'reason'> {
  return {
    page_id: pageId,
    source_revision: sourceRevision(source),
    title: source.title ?? pageId.toUpperCase(),
  };
}

function hasAllReviewedModes(semantic: SemanticProfile): boolean {
  const reviewed = new Set(semantic.reviewed_modes);
  return MODES.every((mode) => reviewed.has(mode));
}

function isHeld(
  pageId: string,
  revision: number,
  catalogCount: number,
  state: MaintenanceState,
): boolean {
  const entry = state.pending[pageId] ?? state.deferred[pageId];
  if (!entry) return false;
  return entry.source_revision === revision && catalogCount < entry.catalog_count + 100;
}

function reconcilePending(state: MaintenanceState, dataset: Dataset): void {
  const revisions = new Map(dataset.profiles.map((profile) => [profile.page_id, profile.source_revision]));
  for (const [pageId, pending] of Object.entries(state.pending)) {
    if (revisions.get(pageId) === pending.source_revision) delete state.pending[pageId];
  }
}

function meaningfulTags(tags: string[]): string[] {
  return [...new Set(tags.filter((tag) =>
    tag !== 'scp' && !tag.startsWith('_') && !/^(series|event)-/.test(tag),
  ))].sort();
}

function normalizeReference(reference: string): string {
  const value = reference.trim().toLowerCase().replace(/^\//, '');
  const match = /^scp-(\d+)$/.exec(value);
  return match ? `scp-${match[1]!.padStart(3, '0')}` : value;
}

function percentile(value: number, sortedValues: number[]): number {
  if (sortedValues.length <= 1) return 1;
  let upper = 0;
  while (upper < sortedValues.length && sortedValues[upper]! <= value) upper += 1;
  return (upper - 1) / (sortedValues.length - 1);
}


function mergeReading(
  left: SemanticProfile['reading'],
  right: NonNullable<SemanticProfile['reading']>,
): NonNullable<SemanticProfile['reading']> {
  return {
    themes: unique([...(left?.themes ?? []), ...right.themes]),
    forms: unique([...(left?.forms ?? []), ...right.forms]),
    structures: unique([...(left?.structures ?? []), ...right.structures]),
    tones: unique([...(left?.tones ?? []), ...right.tones]),
    motifs: unique([...(left?.motifs ?? []), ...right.motifs]),
    moves: uniqueReadingMoves([...(left?.moves ?? []), ...(right.moves ?? [])]),
  };
}

function uniqueReadingMoves(
  moves: NonNullable<SemanticProfile['reading']>['moves'],
): NonNullable<NonNullable<SemanticProfile['reading']>['moves']> {
  const byKey = new Map<string, NonNullable<NonNullable<SemanticProfile['reading']>['moves']>[number]>();
  for (const move of moves ?? []) {
    const key = `${move.kind}:${move.description}:${move.chunk_ids.join(',')}`;
    if (!byKey.has(key)) byKey.set(key, move);
  }
  return [...byKey.values()];
}

function uniqueEdges(edges: Edge[]): Edge[] {
  const uniqueValues = new Map<string, Edge>();
  for (const edge of edges) {
    uniqueValues.set(`${edge.from}:${edge.to}:${edge.type}`, edge);
  }
  return [...uniqueValues.values()].sort((left, right) =>
    left.from.localeCompare(right.from) ||
    left.to.localeCompare(right.to) ||
    left.type.localeCompare(right.type),
  );
}

function interactionKey(interaction: PairInteraction): string {
  return `${interaction.mode}:${interaction.pages.join(':')}`;
}

function comparePageIds(left: { page_id: string }, right: { page_id: string }): number {
  return left.page_id.localeCompare(right.page_id);
}

function boundedLimit(limit: number, policy: SelectionPolicy): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > policy.weekly_analysis_limit) {
    throw new Error(`Analysis limit must be between 1 and ${policy.weekly_analysis_limit}`);
  }
  return limit;
}

function makeRunId(now: Date): string {
  return now.toISOString().replace(/[-:.]/g, '');
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readState(privateDirectory: string): Promise<MaintenanceState> {
  try {
    return await readJson<MaintenanceState>(path.join(privateDirectory, 'state.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
    throw error;
  }
}

function emptyState(): MaintenanceState {
  return { version: 1, catalog_count: 0, deferred: {}, pending: {} };
}

async function writeState(privateDirectory: string, state: MaintenanceState): Promise<void> {
  await writeJson(path.join(privateDirectory, 'state.json'), state);
}

function modelCheckpointPath(
  privateDirectory: string,
  kind: string,
  input: unknown,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex');
  return path.join(privateDirectory, 'model-cache', kind, `${digest}.json`);
}

async function readModelCheckpoint<T>(filePath: string): Promise<T | undefined> {
  try {
    const checkpoint = await readJson<{ version: 1; value: T }>(filePath);
    return checkpoint.version === 1 ? checkpoint.value : undefined;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT' ||
      error instanceof SyntaxError
    ) return undefined;
    throw error;
  }
}

async function writeModelCheckpoint(filePath: string, value: unknown): Promise<void> {
  await writeJson(filePath, { version: 1, value });
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, 'utf8');
  await rename(temporaryPath, filePath);
}

async function readFileIfPresent(filePath: string): Promise<Buffer | undefined> {
  try {
    return await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function buffersEqual(left: Buffer | undefined, right: Buffer | undefined): boolean {
  if (!left || !right) return left === right;
  return left.equals(right);
}

async function defaultCommandRunner(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, args, { cwd, encoding: 'utf8' });
}
