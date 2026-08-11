import { execFile } from 'node:child_process';
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
import { defaultDataDirectory, loadDataset } from './data.js';
import {
  CodexQualitativeModelRunner,
  type ArticleChunk,
  type InteractionCandidate,
  type JudgementReview,
  type QualitativeModelRunner,
} from './model-runner.js';
import {
  fetchItemsIndex,
  normalizedSourceKey,
  SCP_DATA_API_ORIGIN,
  sourceRevision,
  type SourceArticle,
  type SourceIndexEntry,
} from './source-api.js';
import {
  MODES,
  type Dataset,
  type Edge,
  type Effect,
  type Mode,
  type PairInteraction,
  type Profile,
  type SelectionPolicy,
  type SemanticClaim,
  type SemanticProfile,
} from './types.js';
import { validateDataset, validateGoldenRankings } from './validate.js';
import { calculateDatabaseVersion } from './version.js';

type CurationEntry = {
  page_id: string;
  focus_tags: string[];
  known_not?: string[];
  manual_effects?: Array<Omit<Effect, 'evidence'> & {
    section: string;
    locator: string;
  }>;
};

const execFileAsync = promisify(execFile);
const MAX_ARTICLES_PER_EXTRACTION = 5;
const MAX_EXTRACTION_CHARACTERS = 200_000;
const MAX_ARTICLE_CHUNK_CHARACTERS = 175_000;
const MAX_PROFILES_PER_JUDGEMENT = 10;
const MAX_INTERACTION_COUNTERPARTS = 20;
const MAX_ACCEPTED_PER_PROFILE_MODE = 3;

export const PUBLIC_DATA_PATHS = [
  'data/curation.json',
  'data/semantics.json',
  'data/interactions.json',
  'data/edges.jsonl',
  'data/manifest.json',
] as const;

export type MaintenanceReason =
  | 'source-changed'
  | 'missing-semantics'
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

type LoadedArticle = {
  entry: MaintenancePlanEntry;
  source: SourceIndexEntry;
  raw_source: string;
  normalized_source: string;
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
  const runId = options.runId ?? makeRunId(now);
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
    return summary;
  }

  const index = await fetchItemsIndex(options.fetchImpl);
  const articles: LoadedArticle[] = [];
  for (const entry of plan.entries) {
    const source = sourceEntry(index, entry.page_id);
    if (sourceRevision(source) !== entry.source_revision) {
      throw new Error(`Source revision changed during run: ${entry.page_id}`);
    }
    articles.push(
      await loadArticle({
        entry,
        source,
        privateDirectory,
        fetchImpl: options.fetchImpl,
      }),
    );
  }

  const modelRunner = options.modelRunner ?? new CodexQualitativeModelRunner();
  const extracted = new Map<string, SemanticProfile>();
  const deferred = new Map<string, string>();
  const chunks = articles.flatMap(articleChunks);
  for (const batch of extractionBatches(chunks)) {
    try {
      mergeExtractionBatch(
        extracted,
        await modelRunner.extract(batch, runDirectory),
      );
    } catch (error) {
      for (const pageId of new Set(batch.map((chunk) => chunk.page_id))) {
        const entry = plan.entries.find((item) => item.page_id === pageId)!;
        if (entry.reason !== 'catalog-expansion') throw error;
        try {
          const oneArticleChunks = chunks.filter((chunk) => chunk.page_id === pageId);
          mergeExtractionBatch(
            extracted,
            await modelRunner.extract(oneArticleChunks, runDirectory),
          );
        } catch (individualError) {
          deferred.set(pageId, errorMessage(individualError));
        }
      }
    }
  }

  const articleById = new Map(articles.map((article) => [article.entry.page_id, article]));
  for (const [pageId, semantic] of extracted) {
    const article = articleById.get(pageId);
    if (!article) throw new Error(`Model returned an unrequested profile: ${pageId}`);
    validateGeneratedSemantic(semantic, article);
  }
  for (const entry of plan.entries) {
    if (deferred.has(entry.page_id)) continue;
    if (!extracted.has(entry.page_id)) {
      const message = `Model omitted semantic profile: ${entry.page_id}`;
      if (entry.reason !== 'catalog-expansion') throw new Error(message);
      deferred.set(entry.page_id, message);
    }
  }

  const interactionCandidates = buildInteractionCandidates(dataset, extracted, deferred);
  const reviews: JudgementReview[] = [];
  for (const batch of judgementBatches(interactionCandidates)) {
    const expectedPages = new Set(batch.map((candidate) => candidate.subject_page_id));
    try {
      reviews.push(...await modelRunner.judge(batch, runDirectory));
    } catch (error) {
      for (const pageId of expectedPages) {
        const entry = plan.entries.find((item) => item.page_id === pageId);
        if (!entry || entry.reason !== 'catalog-expansion') throw error;
        try {
          const oneProfile = batch.filter(
            (candidate) => candidate.subject_page_id === pageId,
          );
          reviews.push(...await modelRunner.judge(oneProfile, runDirectory));
        } catch (individualError) {
          deferred.set(pageId, errorMessage(individualError));
          extracted.delete(pageId);
        }
      }
    }
  }

  const activeCandidates = interactionCandidates.filter(
    (candidate) => !deferred.has(candidate.subject_page_id),
  );
  validateReviews(activeCandidates, reviews, extracted, dataset);
  const proposedInteractions = limitAcceptedInteractions(
    activeCandidates,
    reviewsToInteractions(activeCandidates, reviews),
  );
  for (const entry of plan.entries) {
    if (entry.reason !== 'catalog-expansion' || deferred.has(entry.page_id)) continue;
    if (!proposedInteractions.some(
      (interaction) =>
        interaction.verdict === 'accepted' && interaction.pages.includes(entry.page_id),
    )) {
      deferred.set(entry.page_id, 'No support A-C interaction with the existing dataset');
      extracted.delete(entry.page_id);
    }
  }
  for (const semantic of extracted.values()) semantic.reviewed_modes = [...MODES];

  const proposalData = await prepareProposalData(dataDirectory, runDirectory);
  const applied = await applyProposal({
    proposalData,
    dataset,
    plan,
    index,
    semantics: extracted,
    interactions: proposedInteractions.filter((interaction) =>
      interaction.pages.every((pageId) => !deferred.has(pageId)),
    ),
  });
  for (const pageId of applied.skipped_pages) {
    deferred.set(pageId, 'Profile failed the public promotion gate');
    extracted.delete(pageId);
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
    proposed: [...extracted.keys()].sort(),
    deferred: [...deferred.keys()].sort(),
    accepted_interactions: accepted,
    rejected_interactions: promotedInteractions.length - accepted,
    proposal_directory: proposalData,
    validation: 'passed',
  };
  await writeJson(path.join(runDirectory, 'summary.json'), summary);

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
  for (const relativePath of verified.changed_paths) {
    const dataRelative = relativePath.slice('data/'.length);
    const target = path.join(dataDirectory, dataRelative);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(proposalData, dataRelative), target);
  }
  const after = await commandRunner('git', ['status', '--porcelain'], repositoryDirectory);
  const actualPaths = parseStatusPaths(after.stdout);
  if (actualPaths.some((item) => !verified.changed_paths.includes(item))) {
    throw new Error(`Publish changed a non-allowlisted path: ${actualPaths.join(', ')}`);
  }
  const branch = `bot/qualitative-refresh-${options.runId}`;
  await commandRunner('git', ['switch', '-c', branch], repositoryDirectory);
  await commandRunner('git', ['add', '--', ...verified.changed_paths], repositoryDirectory);
  await commandRunner(
    'git',
    ['commit', '-m', 'data: refresh qualitative SCP profiles'],
    repositoryDirectory,
  );
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
  await commandRunner('git', ['switch', 'main'], repositoryDirectory);
  return { published: true, pr_url: prUrl, changed_paths: verified.changed_paths };
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

async function loadArticle(options: {
  entry: MaintenancePlanEntry;
  source: SourceIndexEntry;
  privateDirectory: string;
  fetchImpl?: typeof fetch;
}): Promise<LoadedArticle> {
  const contentFile = options.source.content_file;
  if (!contentFile || !/^[A-Za-z0-9._-]+\.json$/.test(contentFile)) {
    throw new Error(`Invalid content shard for ${options.entry.page_id}`);
  }
  const cachePath = path.join(options.privateDirectory, 'cache', 'shards', contentFile);
  let shardText: string;
  let fromCache = true;
  try {
    shardText = await readFile(cachePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    fromCache = false;
    shardText = await fetchContentShard(contentFile, options.fetchImpl);
    await atomicWrite(cachePath, shardText);
  }
  let shard = JSON.parse(shardText) as Record<string, SourceArticle>;
  let article = findArticle(shard, options.entry.page_id, options.source);
  if (fromCache && sourceRevision(article) !== sourceRevision(options.source)) {
    shardText = await fetchContentShard(contentFile, options.fetchImpl);
    await atomicWrite(cachePath, shardText);
    shard = JSON.parse(shardText) as Record<string, SourceArticle>;
    article = findArticle(shard, options.entry.page_id, options.source);
  }
  if (sourceRevision(article) !== sourceRevision(options.source)) {
    throw new Error(`Content revision does not match index: ${options.entry.page_id}`);
  }
  const rawSource = article.raw_source;
  if (!rawSource?.trim()) {
    throw new Error(`SCP Data API has no raw_source for ${options.entry.page_id}`);
  }
  return {
    entry: options.entry,
    source: options.source,
    raw_source: rawSource,
    normalized_source: normalizeArticleSource(rawSource),
  };
}

async function fetchContentShard(
  contentFile: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string> {
  const url = new URL(`/data/scp/items/${contentFile}`, SCP_DATA_API_ORIGIN);
  const response = await fetchImpl(url, { redirect: 'error' });
  if (!response.ok) {
    throw new Error(`SCP content request failed (${response.status}) for ${contentFile}`);
  }
  return response.text();
}

function findArticle(
  shard: Record<string, SourceArticle>,
  pageId: string,
  source: SourceIndexEntry,
): SourceArticle {
  const keys = [
    normalizedSourceKey(pageId),
    pageId,
    pageId.toUpperCase(),
    String(source.page_id ?? ''),
  ];
  for (const key of keys) {
    if (shard[key]) return shard[key]!;
  }
  const found = Object.values(shard).find((article) =>
    article.url === source.url ||
    article.link?.replace(/^\//, '').toLowerCase() === pageId,
  );
  if (!found) throw new Error(`Content shard does not contain ${pageId}`);
  return found;
}

export function normalizeArticleSource(rawSource: string): string {
  const lines = rawSource.replace(/\r\n?/g, '\n').split('\n');
  const filtered: string[] = [];
  let inComment = false;
  let skipUntil: RegExp | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (skipUntil) {
      if (skipUntil.test(trimmed)) skipUntil = undefined;
      continue;
    }
    if (trimmed.startsWith('[!--')) inComment = true;
    if (inComment) {
      if (trimmed.endsWith('--]')) inComment = false;
      continue;
    }
    if (/^\[\[include\b.*component:license-box/i.test(trimmed)) break;
    if (/^\[\[div\b.*footer-wikiwalk-nav/i.test(trimmed)) {
      skipUntil = /^\[\[\/div\]\]$/i;
      continue;
    }
    if (/^\[\[module\b/i.test(trimmed)) {
      skipUntil = /^\[\[(?:\/module|\/>)\]\]$/i;
      continue;
    }
    if (/^\[\[(?:include|image)\b/i.test(trimmed)) {
      if (!trimmed.endsWith(']]')) skipUntil = /\]\]$/;
      continue;
    }
    if (/^\[\[(?:iftags|\/iftags)\b/i.test(trimmed)) continue;
    if (/^\[\[(?:> |< )?image\b/i.test(trimmed)) continue;
    filtered.push(line.replace(/[ \t]+$/g, ''));
  }
  return filtered.join('\n').replace(/\n{4,}/g, '\n\n\n').trim();
}

function articleChunks(article: LoadedArticle): ArticleChunk[] {
  const text = article.normalized_source;
  if (text.length <= MAX_ARTICLE_CHUNK_CHARACTERS) {
    return [{
      page_id: article.entry.page_id,
      source_revision: article.entry.source_revision,
      title: article.entry.title,
      chunk_id: '1/1',
      source: text,
    }];
  }
  const sections = text.split(/(?=^\+{1,6}\s+)/m);
  const chunks: string[] = [];
  let current = '';
  for (const section of sections) {
    if (current && current.length + section.length > MAX_ARTICLE_CHUNK_CHARACTERS) {
      chunks.push(current.trim());
      current = '';
    }
    if (section.length > MAX_ARTICLE_CHUNK_CHARACTERS) {
      for (let offset = 0; offset < section.length; offset += MAX_ARTICLE_CHUNK_CHARACTERS) {
        const piece = section.slice(offset, offset + MAX_ARTICLE_CHUNK_CHARACTERS);
        if (current) chunks.push(current.trim());
        chunks.push(piece.trim());
        current = '';
      }
    } else {
      current += section;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.map((source, index) => ({
    page_id: article.entry.page_id,
    source_revision: article.entry.source_revision,
    title: article.entry.title,
    chunk_id: `${index + 1}/${chunks.length}`,
    source,
  }));
}

function extractionBatches(chunks: ArticleChunk[]): ArticleChunk[][] {
  const batches: ArticleChunk[][] = [];
  let current: ArticleChunk[] = [];
  let characters = 0;
  let pages = new Set<string>();
  for (const chunk of chunks) {
    const nextPages = new Set(pages).add(chunk.page_id);
    if (
      current.length > 0 &&
      (characters + chunk.source.length > MAX_EXTRACTION_CHARACTERS ||
        nextPages.size > MAX_ARTICLES_PER_EXTRACTION)
    ) {
      batches.push(current);
      current = [];
      characters = 0;
      pages = new Set();
    }
    current.push(chunk);
    characters += chunk.source.length;
    pages.add(chunk.page_id);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function mergeExtractionBatch(
  target: Map<string, SemanticProfile>,
  profiles: SemanticProfile[],
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

function validateGeneratedSemantic(
  semantic: SemanticProfile,
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
  const normalizedRaw = normalizeWhitespace(article.raw_source);
  const claimIds = new Set<string>();
  for (const claim of semantic.claims) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(claim.id) || claimIds.has(claim.id)) {
      throw new Error(`Invalid generated claim ID: ${semantic.page_id}/${claim.id}`);
    }
    claimIds.add(claim.id);
    for (const evidence of claim.evidence) {
      if (evidence.revision !== semantic.source_revision) {
        throw new Error(`Generated evidence revision mismatch: ${semantic.page_id}/${claim.id}`);
      }
      const locator = normalizeWhitespace(evidence.locator);
      if (locator.length < 12 || !normalizedRaw.includes(locator)) {
        throw new Error(`Generated evidence is not an exact source excerpt: ${semantic.page_id}/${claim.id}`);
      }
    }
  }
}

function buildInteractionCandidates(
  dataset: Dataset,
  generated: Map<string, SemanticProfile>,
  deferred: Map<string, string>,
): InteractionCandidate[] {
  const allSemantics = new Map(dataset.semantics.map((item) => [item.page_id, item]));
  for (const [pageId, semantic] of generated) allSemantics.set(pageId, semantic);
  const profiles = new Map(dataset.profiles.map((profile) => [profile.page_id, profile]));
  const output: InteractionCandidate[] = [];
  const seen = new Set<string>();
  for (const [pageId, semantic] of [...generated].sort(([left], [right]) => left.localeCompare(right))) {
    if (deferred.has(pageId)) continue;
    const counterparts = [...allSemantics.values()]
      .filter((candidate) => candidate.page_id !== pageId)
      .map((candidate) => ({
        semantic: candidate,
        score: semanticCandidateScore(semantic, candidate, profiles),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) =>
        right.score - left.score || left.semantic.page_id.localeCompare(right.semantic.page_id),
      )
      .slice(0, MAX_INTERACTION_COUNTERPARTS);
    for (const { semantic: counterpart } of counterparts) {
      const [left, right] = [semantic, counterpart].sort((a, b) =>
        a.page_id.localeCompare(b.page_id),
      );
      for (const mode of MODES) {
        const reviewId = `${mode}:${left.page_id}:${right.page_id}`;
        if (seen.has(reviewId)) continue;
        seen.add(reviewId);
        output.push({
          review_id: reviewId,
          subject_page_id: pageId,
          mode,
          left,
          right,
          left_title: profiles.get(left.page_id)?.title ?? left.page_id.toUpperCase(),
          right_title: profiles.get(right.page_id)?.title ?? right.page_id.toUpperCase(),
        });
      }
    }
  }
  return output;
}

function judgementBatches(candidates: InteractionCandidate[]): InteractionCandidate[][] {
  const byPrimary = new Map<string, InteractionCandidate[]>();
  for (const candidate of candidates) {
    const primary = candidate.subject_page_id;
    const list = byPrimary.get(primary) ?? [];
    list.push(candidate);
    byPrimary.set(primary, list);
  }
  const batches: InteractionCandidate[][] = [];
  let current: InteractionCandidate[] = [];
  let profileCount = 0;
  for (const list of byPrimary.values()) {
    if (profileCount === MAX_PROFILES_PER_JUDGEMENT) {
      batches.push(current);
      current = [];
      profileCount = 0;
    }
    current.push(...list);
    profileCount += 1;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function validateReviews(
  candidates: InteractionCandidate[],
  reviews: JudgementReview[],
  generated: Map<string, SemanticProfile>,
  dataset: Dataset,
): void {
  const expected = new Map(candidates.map((candidate) => [candidate.review_id, candidate]));
  const seen = new Set<string>();
  const semantics = new Map(dataset.semantics.map((item) => [item.page_id, item]));
  for (const [pageId, semantic] of generated) semantics.set(pageId, semantic);
  for (const review of reviews) {
    const candidate = expected.get(review.review_id);
    if (!candidate || seen.has(review.review_id)) {
      throw new Error(`Unexpected or duplicate interaction review: ${review.review_id}`);
    }
    seen.add(review.review_id);
    if (review.verdict === 'rejected') {
      if (!review.reason.trim()) throw new Error(`Rejected review has no reason: ${review.review_id}`);
      continue;
    }
    if (
      !review.mechanism.trim() ||
      !review.explanation.trim() ||
      review.causal_chain.length === 0 ||
      (!review.assumption.trim() && !review.limitation.trim()) ||
      review.left_claim_refs.length === 0 ||
      review.right_claim_refs.length === 0
    ) {
      throw new Error(`Accepted review is incomplete: ${review.review_id}`);
    }
    const leftClaims = new Set(semantics.get(candidate.left.page_id)?.claims.map((claim) => claim.id));
    const rightClaims = new Set(semantics.get(candidate.right.page_id)?.claims.map((claim) => claim.id));
    if (
      review.left_claim_refs.some((claim) => !leftClaims.has(claim)) ||
      review.right_claim_refs.some((claim) => !rightClaims.has(claim))
    ) {
      throw new Error(`Accepted review cites an unknown claim: ${review.review_id}`);
    }
  }
  const missing = [...expected.keys()].filter((reviewId) => !seen.has(reviewId));
  if (missing.length > 0) {
    throw new Error(`Model omitted interaction reviews: ${missing.slice(0, 5).join(', ')}`);
  }
}

function reviewsToInteractions(
  candidates: InteractionCandidate[],
  reviews: JudgementReview[],
): PairInteraction[] {
  const candidateById = new Map(candidates.map((candidate) => [candidate.review_id, candidate]));
  return reviews.map((review) => {
    const candidate = candidateById.get(review.review_id)!;
    const pages: [string, string] = [candidate.left.page_id, candidate.right.page_id];
    const sourceRevisions = {
      [pages[0]]: candidate.left.source_revision,
      [pages[1]]: candidate.right.source_revision,
    };
    const id = `auto-${candidate.mode}-${pages[0]}-${pages[1]}`;
    if (review.verdict === 'rejected') {
      return {
        id,
        pages,
        mode: candidate.mode,
        source_revisions: sourceRevisions,
        verdict: 'rejected',
        reason: review.reason,
      };
    }
    return {
      id,
      pages,
      mode: candidate.mode,
      source_revisions: sourceRevisions,
      verdict: 'accepted',
      mechanism: review.mechanism,
      claim_refs: {
        [pages[0]]: review.left_claim_refs,
        [pages[1]]: review.right_claim_refs,
      },
      causal_chain: review.causal_chain,
      explanation: review.explanation,
      ...(review.assumption.trim() ? { assumption: review.assumption.trim() } : {}),
      ...(review.limitation.trim() ? { limitation: review.limitation.trim() } : {}),
      rubric: review.rubric,
      support: review.support,
    };
  });
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
  interactions: PairInteraction[];
}): Promise<{ promoted: PairInteraction[]; skipped_pages: string[] }> {
  const profiles = new Map(options.dataset.profiles.map((profile) => [profile.page_id, profile]));
  const curation = await readJson<CurationEntry[]>(path.join(options.proposalData, 'curation.json'));
  let edges = [...options.dataset.edges];
  const semanticById = new Map(options.dataset.semantics.map((item) => [item.page_id, item]));
  const changedRevisions = new Set(
    options.plan.entries
      .filter((entry) => entry.reason === 'source-changed')
      .map((entry) => entry.page_id),
  );
  let curationChanged = false;
  let edgesChanged = false;
  const changedProfiles = new Map<string, Profile>();
  const skippedPages = new Set<string>();
  for (const [pageId, semantic] of options.semantics) {
    semanticById.set(pageId, semantic);
    const planEntryValue = options.plan.entries.find((entry) => entry.page_id === pageId)!;
    if (planEntryValue.reason === 'missing-semantics') continue;
    const source = sourceEntry(options.index, pageId);
    const existing = profiles.get(pageId);
    const profile = profileFromSemantic(pageId, source, semantic, existing);
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
    const planEntryValue = options.plan.entries.find((entry) => entry.page_id === pageId)!;
    if (planEntryValue.reason === 'missing-semantics') continue;
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
    if (interaction.pages.some((pageId) => changedRevisions.has(pageId))) continue;
    interactionByKey.set(interactionKey(interaction), interaction);
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
  if (baseGoldenErrors.length > 0) {
    throw new Error(`Profile update regressed golden rankings:\n${baseGoldenErrors.join('\n')}`);
  }
  let promoted: PairInteraction[] = [];
  for (const interaction of [...options.interactions]
    .filter((item) => item.pages.every((pageId) => profiles.has(pageId)))
    .sort(compareInteractionQuality)) {
    const key = interactionKey(interaction);
    const previous = interactionByKey.get(key);
    interactionByKey.set(key, interaction);
    const candidateDataset = {
      ...baseDataset,
      interactions: [...interactionByKey.values()],
    };
    if (validateGoldenRankings(candidateDataset).length === 0) {
      promoted.push(interaction);
    } else if (previous) {
      interactionByKey.set(key, previous);
    } else {
      interactionByKey.delete(key);
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
  const databaseVersion = calculateDatabaseVersion(
    profileValues,
    edges,
    semanticValues,
    interactionValues,
  );
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
    })),
  };
  await writeJson(path.join(options.proposalData, 'manifest.json'), manifest);
  return { promoted, skipped_pages: [...skippedPages].sort() };
}

function limitAcceptedInteractions(
  candidates: InteractionCandidate[],
  interactions: PairInteraction[],
): PairInteraction[] {
  const subjectByKey = new Map(candidates.map((candidate) => [
    `${candidate.mode}:${candidate.left.page_id}:${candidate.right.page_id}`,
    candidate.subject_page_id,
  ]));
  const acceptedByGroup = new Map<string, PairInteraction[]>();
  const kept = interactions.filter((interaction) => {
    if (interaction.verdict === 'rejected') return true;
    const subject = subjectByKey.get(interactionKey(interaction));
    if (!subject) return false;
    const group = `${subject}:${interaction.mode}`;
    const values = acceptedByGroup.get(group) ?? [];
    values.push(interaction);
    acceptedByGroup.set(group, values);
    return false;
  });
  for (const values of acceptedByGroup.values()) {
    kept.push(...values.sort(compareInteractionQuality).slice(0, MAX_ACCEPTED_PER_PROFILE_MODE));
  }
  return kept;
}

function compareInteractionQuality(left: PairInteraction, right: PairInteraction): number {
  return interactionQuality(right) - interactionQuality(left) || left.id.localeCompare(right.id);
}

function interactionQuality(interaction: PairInteraction): number {
  if (interaction.verdict === 'rejected') return 0;
  const support = { A: 30, B: 20, C: 10 }[interaction.support];
  const modeFit = { core: 6, strong: 4, partial: 0 }[interaction.rubric.mode_fit];
  const coherence = { complete: 3, conditional: 2, thematic: 0 }[interaction.rubric.coherence];
  const specificity = {
    'article-specific': 6,
    'domain-specific': 2,
    generic: 0,
  }[interaction.rubric.specificity];
  const discovery = { high: 3, medium: 2, low: 0 }[interaction.rubric.discovery_value];
  return support + modeFit + coherence + specificity + discovery;
}

function profileFromSemantic(
  pageId: string,
  source: SourceIndexEntry,
  semantic: SemanticProfile,
  existing?: Profile,
): Profile {
  const effects = semantic.claims.flatMap((claim) => {
    if (claim.kind === 'narrative') return [];
    const evidence = claim.evidence[0];
    if (!evidence) return [];
    return [{
      domain: claim.domain,
      operation: claim.operation,
      target: claim.target ?? claim.subject ?? 'article-specific-subject',
      trigger: claim.trigger ?? claim.preconditions[0] ?? 'article-defined-condition',
      persistence: claim.persistence ?? 'article-defined',
      constraints: [...claim.limitations],
      evidence,
    } satisfies Effect];
  });
  if (effects.length === 0) throw new Error(`No effects can be derived for ${pageId}`);
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
    themes: semantic.reading?.themes ?? meaningfulTags(source.tags ?? []).slice(0, 5),
    effects,
    ...(existing?.known_not ? { known_not: existing.known_not } : {}),
    curated: true,
  };
}

function curationFromProfile(profile: Profile): CurationEntry {
  return {
    page_id: profile.page_id,
    focus_tags: [],
    manual_effects: profile.effects.map(({ evidence, ...effect }) => ({
      ...effect,
      section: evidence.section,
      locator: evidence.locator,
    })),
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
  const reviewed = new Set(semantic.reviewed_modes ?? []);
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

function semanticCandidateScore(
  left: SemanticProfile,
  right: SemanticProfile,
  profiles: Map<string, Profile>,
): number {
  const leftClaims = left.claims;
  const rightClaims = right.claims;
  const leftOperations = new Set(leftClaims.map((claim) => claim.operation));
  const rightOperations = new Set(rightClaims.map((claim) => claim.operation));
  const leftDomains = new Set(leftClaims.map((claim) => claim.domain));
  const rightDomains = new Set(rightClaims.map((claim) => claim.domain));
  const leftOutcomes = new Set(leftClaims.flatMap((claim) => claim.outcomes));
  const rightConditions = new Set(rightClaims.flatMap((claim) => claim.preconditions));
  const tagsLeft = new Set(meaningfulTags(profiles.get(left.page_id)?.tags ?? []));
  const tagsRight = new Set(meaningfulTags(profiles.get(right.page_id)?.tags ?? []));
  return (
    intersectionSize(leftOperations, rightOperations) * 3 +
    intersectionSize(leftDomains, rightDomains) * 2 +
    intersectionSize(leftOutcomes, rightConditions) * 4 +
    intersectionSize(tagsLeft, tagsRight) +
    intersectionSize(
      new Set(left.reading?.motifs ?? []),
      new Set(right.reading?.motifs ?? []),
    ) * 2
  );
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

function intersectionSize<T>(left: Set<T>, right: Set<T>): number {
  let count = 0;
  for (const value of left) if (right.has(value)) count += 1;
  return count;
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
  };
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
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
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

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
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
