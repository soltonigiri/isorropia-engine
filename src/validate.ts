import { IsorropiaEngine } from './engine.js';
import { DISCLAIMER, MODES, type Dataset, type Evidence } from './types.js';
import { calculateDatabaseVersion } from './version.js';
import { analysisPolicyDigests, interactionSemanticDigest } from './analysis-policy.js';
import { compileProfileEffects, compileReadingThemes } from './profile-compiler.js';
import { validateModeProof } from './interaction-review.js';

export type ValidationResult = {
  valid: boolean;
  errors: string[];
};

export function validateDataset(dataset: Dataset): ValidationResult {
  const errors: string[] = [];
  const policyDigests = analysisPolicyDigests({
    policy: dataset.analysisPolicy,
    ontology: dataset.semanticOntology,
  });
  const profileIds = new Set<string>();
  const profilesById = new Map(dataset.profiles.map((profile) => [profile.page_id, profile]));

  if (dataset.profiles.length < 100) {
    errors.push(`Expected at least 100 profiles, got ${dataset.profiles.length}`);
  }
  for (const profile of dataset.profiles) {
    if (!/^scp-\d{3,}$/.test(profile.page_id)) {
      errors.push(`Invalid page_id: ${profile.page_id}`);
    }
    if (profileIds.has(profile.page_id)) {
      errors.push(`Duplicate profile: ${profile.page_id}`);
    }
    profileIds.add(profile.page_id);
    if (!profile.curated) errors.push(`Profile is not curated: ${profile.page_id}`);
    if (profile.language !== 'en') errors.push(`Unsupported language: ${profile.page_id}`);
    if (!profile.url.startsWith('https://scp-wiki.wikidot.com/')) {
      errors.push(`Invalid source URL: ${profile.page_id}`);
    }
    if (profile.effects.length === 0) {
      errors.push(`Profile has no effects: ${profile.page_id}`);
    }
    for (const effect of profile.effects) {
      validateEvidence(effect.evidence, profile.page_id, profile.source_revision, errors);
      if (effect.evidence.section === 'metadata.tags') {
        errors.push(`Profile effect uses metadata-only evidence: ${profile.page_id}`);
      }
    }
  }

  const ruleIds = new Set<string>();
  if (dataset.rules.length < 20) {
    errors.push(`Expected at least 20 rules, got ${dataset.rules.length}`);
  }
  for (const rule of dataset.rules) {
    if (ruleIds.has(rule.id)) errors.push(`Duplicate rule: ${rule.id}`);
    ruleIds.add(rule.id);
    if (!MODES.includes(rule.mode)) errors.push(`Invalid mode on rule: ${rule.id}`);
    if (!Number.isFinite(rule.weight) || rule.weight <= 0) {
      errors.push(`Invalid rule weight: ${rule.id}`);
    }
  }

  for (const edge of dataset.edges) {
    const sourceProfile = profilesById.get(edge.from);
    if (!sourceProfile || !profileIds.has(edge.to)) {
      errors.push(`Edge references unknown profile: ${edge.from} -> ${edge.to}`);
    }
    validateEvidence(
      edge.evidence,
      `${edge.from} -> ${edge.to}`,
      sourceProfile?.source_revision ?? edge.evidence.revision,
      errors,
    );
  }

  const semanticsById = new Map(dataset.semantics.map((profile) => [profile.page_id, profile]));
  const semanticIds = new Set<string>();
  for (const semantic of dataset.semantics) {
    if (semanticIds.has(semantic.page_id)) {
      errors.push(`Duplicate semantic profile: ${semantic.page_id}`);
    }
    semanticIds.add(semantic.page_id);
    const profile = profilesById.get(semantic.page_id);
    if (!profile) {
      errors.push(`Semantic profile references unknown page: ${semantic.page_id}`);
      continue;
    }
    if (semantic.source_revision !== profile.source_revision) {
      errors.push(`Semantic profile revision mismatch: ${semantic.page_id}`);
    }
    const reviewed = new Set(semantic.reviewed_modes);
    if (reviewed.size !== semantic.reviewed_modes.length) {
      errors.push(`Duplicate reviewed mode: ${semantic.page_id}`);
    }
    for (const mode of semantic.reviewed_modes) {
      if (!MODES.includes(mode)) {
        errors.push(`Invalid reviewed mode: ${semantic.page_id}/${mode}`);
      }
    }
    if (MODES.some((mode) => !reviewed.has(mode))) {
      errors.push(`Semantic profile is not reviewed for every mode: ${semantic.page_id}`);
    }
    const claimIds = new Set<string>();
    if (semantic.schema_version !== 2 || !semantic.semantic_policy_digest.trim()) {
      errors.push(`Semantic provenance is incomplete: ${semantic.page_id}`);
    } else if (semantic.semantic_policy_digest !== policyDigests.semantic) {
      errors.push(`Semantic policy is stale: ${semantic.page_id}`);
    } else if (semantic.coverage.analyzed_chunk_ids.length === 0) {
      errors.push(`Semantic profile has no analyzed chunks: ${semantic.page_id}`);
    }
    try {
      if (JSON.stringify(profile.effects) !== JSON.stringify(
        compileProfileEffects(semantic, dataset.semanticOntology),
      )) {
        errors.push(`Profile effects do not match semantic profile: ${semantic.page_id}`);
      }
      if (JSON.stringify(profile.themes) !== JSON.stringify(
        compileReadingThemes(semantic.reading),
      )) {
        errors.push(`Profile themes do not match semantic profile: ${semantic.page_id}`);
      }
    } catch (error) {
      errors.push(`Semantic profile cannot compile: ${semantic.page_id}: ${errorMessage(error)}`);
    }
    for (const claim of semantic.claims) {
      if (!claim.id.trim() || claimIds.has(claim.id)) {
        errors.push(`Invalid or duplicate semantic claim: ${semantic.page_id}/${claim.id}`);
      }
      claimIds.add(claim.id);
      if (claim.evidence.length === 0) {
        errors.push(`Semantic claim has no evidence: ${semantic.page_id}/${claim.id}`);
      }
      if (!claim.role || !dataset.semanticOntology.claim_roles.includes(claim.role)) {
        errors.push(`Semantic claim has invalid role: ${semantic.page_id}/${claim.id}`);
      }
      if (!claim.operation_class || !Object.hasOwn(
        dataset.semanticOntology.operations,
        claim.operation_class,
      )) {
        errors.push(`Semantic claim has invalid operation class: ${semantic.page_id}/${claim.id}`);
      }
      if (!claim.domain_class || !Object.hasOwn(
        dataset.semanticOntology.domains,
        claim.domain_class,
      )) {
        errors.push(`Semantic claim has invalid domain class: ${semantic.page_id}/${claim.id}`);
      }
      if (!claim.affected_state || !Object.hasOwn(
        dataset.semanticOntology.affected_states,
        claim.affected_state,
      )) {
        errors.push(`Semantic claim has invalid affected state: ${semantic.page_id}/${claim.id}`);
      }
      if (!claim.direction || !dataset.semanticOntology.directions.includes(claim.direction)) {
        errors.push(`Semantic claim has invalid direction: ${semantic.page_id}/${claim.id}`);
      }
      validateChunkReferences(
        claim.chunk_ids,
        semantic.coverage.analyzed_chunk_ids,
        `${semantic.page_id}/${claim.id}`,
        errors,
      );
      for (const evidence of claim.evidence) {
        validateEvidence(evidence, `${semantic.page_id}/${claim.id}`, semantic.source_revision, errors);
      }
    }
    for (const [index, move] of (semantic.reading?.moves ?? []).entries()) {
      const owner = `${semantic.page_id}/reading-${move.kind}-${index + 1}`;
      validateChunkReferences(
        move.chunk_ids,
        semantic.coverage.analyzed_chunk_ids,
        owner,
        errors,
      );
      if (move.evidence.length === 0) errors.push(`Reading move has no evidence: ${owner}`);
      for (const evidence of move.evidence) {
        validateEvidence(evidence, owner, semantic.source_revision, errors);
      }
    }
  }
  for (const pageId of profileIds) {
    if (!semanticIds.has(pageId)) errors.push(`Missing semantic profile: ${pageId}`);
  }

  const interactionIds = new Set<string>();
  const interactionKeys = new Set<string>();
  for (const interaction of dataset.interactions) {
    if (interactionIds.has(interaction.id)) errors.push(`Duplicate interaction: ${interaction.id}`);
    interactionIds.add(interaction.id);
    const expectedPages = [...interaction.pages].sort();
    if (interaction.pages[0] !== expectedPages[0] || interaction.pages[1] !== expectedPages[1]) {
      errors.push(`Interaction pages are not sorted: ${interaction.id}`);
    }
    const key = `${interaction.mode}:${interaction.pages.join(':')}`;
    if (interactionKeys.has(key)) errors.push(`Duplicate interaction pair: ${key}`);
    interactionKeys.add(key);
    for (const pageId of interaction.pages) {
      const profile = profilesById.get(pageId);
      if (!profile) {
        errors.push(`Interaction references unknown page: ${interaction.id}/${pageId}`);
        continue;
      }
      if (interaction.source_revisions[pageId] !== profile.source_revision) {
        errors.push(`Interaction revision mismatch: ${interaction.id}/${pageId}`);
      }
    }
    validateInteractionProvenance(interaction, semanticsById, policyDigests, errors);
    if (interaction.verdict === 'rejected') {
      if (!interaction.reason.trim()) errors.push(`Rejected interaction has no reason: ${interaction.id}`);
      continue;
    }
    if (!interaction.explanation.trim() || interaction.causal_chain.length === 0) {
      errors.push(`Accepted interaction is incomplete: ${interaction.id}`);
    }
    if (!['A', 'B', 'C'].includes(interaction.support)) {
      errors.push(`Accepted interaction has unsupported evidence grade: ${interaction.id}`);
    }
    try {
      validateModeProof(interaction.proof, {
        id: interaction.id,
        mode: interaction.mode,
        pages: interaction.pages,
      }, semanticsById);
    } catch (error) {
      errors.push(`Invalid interaction proof: ${errorMessage(error)}`);
    }
    if (interaction.pages.some((pageId) =>
      semanticsById.get(pageId)?.coverage.status === 'partial')) {
      if (interaction.mode === 'double-feature') {
        errors.push(`Double-feature interaction requires complete source coverage: ${interaction.id}`);
      }
      if (interaction.support !== 'C' || !interaction.limitation?.trim()) {
        errors.push(`Partial-coverage interaction must be support C with a limitation: ${interaction.id}`);
      }
    }
    for (const pageId of interaction.pages) {
      const refs = interaction.claim_refs[pageId] ?? [];
      if (refs.length === 0) {
        errors.push(`Interaction has no claim reference: ${interaction.id}/${pageId}`);
        continue;
      }
      const claims = semanticsById.get(pageId)?.claims ?? [];
      for (const ref of refs) {
        if (!claims.some((claim) => claim.id === ref)) {
          errors.push(`Interaction references unknown claim: ${interaction.id}/${pageId}/${ref}`);
        }
      }
    }
  }

  validateSelectionPolicy(dataset, errors);
  validateScoringPolicy(dataset, errors);
  validateAnalysisPolicy(dataset, errors);

  if (dataset.manifest.profile_count !== dataset.profiles.length) {
    errors.push('Manifest profile_count does not match profiles');
  }
  if (
    dataset.manifest.database_version !==
    calculateDatabaseVersion({
      profiles: dataset.profiles,
      edges: dataset.edges,
      semantics: dataset.semantics,
      interactions: dataset.interactions,
      semanticOntology: dataset.semanticOntology,
      analysisPolicy: dataset.analysisPolicy,
    })
  ) {
    errors.push('Manifest database_version does not match profiles and edges');
  }
  if (dataset.manifest.attributions.length !== dataset.profiles.length) {
    errors.push('Manifest attribution count does not match profiles');
  }
  const attributed = new Set(dataset.manifest.attributions.map((entry) => entry.page_id));
  for (const entry of dataset.manifest.attributions) {
    const unresolved = entry.authors.length === 0 || entry.authors.includes('Unknown Author');
    if ((unresolved ? 'unresolved' : 'verified') !== entry.status) {
      errors.push(`Attribution status mismatch: ${entry.page_id}`);
    }
  }
  for (const pageId of profileIds) {
    if (!attributed.has(pageId)) errors.push(`Missing attribution: ${pageId}`);
  }

  if (dataset.golden.length < 10) {
    errors.push(`Expected at least 10 reviewed golden cases, got ${dataset.golden.length}`);
  }
  const goldenIds = new Set<string>();
  for (const golden of dataset.golden) {
    if (goldenIds.has(golden.id)) errors.push(`Duplicate golden case: ${golden.id}`);
    goldenIds.add(golden.id);
    if (!profileIds.has(golden.left) || (golden.right && !profileIds.has(golden.right))) {
      errors.push(`Golden case references unknown profile: ${golden.id}`);
    }
  }
  const engine = errors.length === 0 ? new IsorropiaEngine(dataset) : undefined;
  if (engine) errors.push(...goldenRankingErrors(dataset, engine));

  if (engine) {
    for (const profile of dataset.profiles) {
      for (const mode of MODES) {
        const response = engine.pair({ pageId: profile.page_id, mode });
        if (response.results.length > 5) {
          errors.push(`Default result count exceeds 5: ${profile.page_id}/${mode}`);
        }
        if (response.disclaimer !== DISCLAIMER) {
          errors.push(`Disclaimer mismatch: ${profile.page_id}/${mode}`);
        }
        for (const result of response.results) {
          if (result.rules.length === 0) {
            errors.push(`Missing result rule: ${profile.page_id}/${mode}/${result.page_id}`);
          }
          if (!result.evidence.query || !result.evidence.candidate) {
            errors.push(`Missing result evidence: ${profile.page_id}/${result.page_id}`);
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

function validateInteractionProvenance(
  interaction: Dataset['interactions'][number],
  semanticsById: Map<string, Dataset['semantics'][number]>,
  policyDigests: ReturnType<typeof analysisPolicyDigests>,
  errors: string[],
): void {
  if (!interaction.semantic_digests || !interaction.candidate_policy_digest || !interaction.review_policy_digest) {
    errors.push(`Interaction has no policy provenance: ${interaction.id}`);
    return;
  }
  if (
    interaction.verdict === 'accepted' &&
    interaction.review_policy_digest !== policyDigests.review_modes[interaction.mode]
  ) {
    errors.push(`Interaction policy is stale: ${interaction.id}`);
  }
  for (const pageId of interaction.pages) {
    const semantic = semanticsById.get(pageId);
    if (semantic && interaction.semantic_digests[pageId] !== interactionSemanticDigest(semantic)) {
      errors.push(`Interaction semantic is stale: ${interaction.id}/${pageId}`);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function validateGoldenRankings(dataset: Dataset): string[] {
  return goldenRankingErrors(dataset, new IsorropiaEngine(dataset));
}

function goldenRankingErrors(dataset: Dataset, engine: IsorropiaEngine): string[] {
  const errors: string[] = [];
  for (const golden of dataset.golden) {
    const results = engine
      .pair({
        pageId: golden.left,
        mode: golden.mode,
        limit: 99,
        setting: golden.expectation === 'include' ? 'rough' : undefined,
      })
      .results;
    if (golden.expectation === 'empty') {
      if (golden.right !== undefined) errors.push(`Empty golden case has a right profile: ${golden.id}`);
      if (results.length !== 0) errors.push(`Empty golden case returned results: ${golden.id}`);
      continue;
    }
    if (!golden.right) {
      errors.push(`Golden case has no right profile: ${golden.id}`);
      continue;
    }
    const rank = results.findIndex((candidate) => candidate.page_id === golden.right);
    const result = rank >= 0 ? results[rank] : undefined;
    if (golden.expectation === 'exclude') {
      const inspection = engine.inspect({
        pageId: golden.left,
        candidatePageId: golden.right,
        mode: golden.mode,
      });
      if (inspection.status === 'accepted') {
        errors.push(`Excluded golden case was accepted: ${golden.id}`);
      }
      continue;
    }
    if (!result || result.score < (golden.minimum_score ?? 0)) {
      errors.push(`Golden case score below minimum: ${golden.id}`);
      continue;
    }
    if (golden.maximum_rank !== undefined && rank + 1 > golden.maximum_rank) {
      errors.push(`Golden case rank is too low: ${golden.id}`);
    }
    if (
      golden.required_rule &&
      !result.rules.some((rule) => rule.id === golden.required_rule)
    ) {
      errors.push(`Golden case rule missing: ${golden.id}`);
    }
  }
  return errors;
}

function validateSelectionPolicy(dataset: Dataset, errors: string[]): void {
  const policy = dataset.selectionPolicy;
  if (!Number.isInteger(policy.version) || policy.version < 1) {
    errors.push('Invalid selection policy version');
  }
  if (
    !Number.isInteger(policy.weekly_analysis_limit) ||
    policy.weekly_analysis_limit < 1 ||
    policy.weekly_analysis_limit > 100
  ) {
    errors.push('Invalid weekly analysis limit');
  }
  const total = Object.values(policy.weights).reduce((sum, weight) => sum + weight, 0);
  if (Math.abs(total - 1) > Number.EPSILON * 10) {
    errors.push('Selection policy weights must total 1');
  }
}

function validateScoringPolicy(dataset: Dataset, errors: string[]): void {
  const policy = dataset.scoringPolicy;
  if (!Number.isInteger(policy.version) || policy.version < 1) {
    errors.push('Invalid scoring policy version');
  }
  const thresholds = Object.values(policy.setting_thresholds);
  if (thresholds.some((value) => value < 0 || value > 1)) {
    errors.push('Scoring thresholds must be between 0 and 1');
  }
  if (thresholds.some((value, index) => index > 0 && value < thresholds[index - 1]!)) {
    errors.push('Scoring thresholds must be ordered');
  }
  const confidence = Object.values(policy.support_confidence);
  if (confidence.some((value) => value < 0 || value > 1)) {
    errors.push('Support confidence must be between 0 and 1');
  }
  for (const fallback of Object.values(policy.fallback)) {
    if (fallback.score_cap < 0 || fallback.score_cap > 100) {
      errors.push('Fallback score caps must be between 0 and 100');
    }
    if (fallback.confidence < 0 || fallback.confidence > 1) {
      errors.push('Fallback confidence must be between 0 and 1');
    }
  }
}

function validateAnalysisPolicy(dataset: Dataset, errors: string[]): void {
  const policy = dataset.analysisPolicy;
  if (!Number.isInteger(policy.version) || policy.version < 1) {
    errors.push('Invalid analysis policy version');
  }
  if (
    policy.source.maximum_depth < 1 ||
    policy.source.maximum_segments < 1 ||
    policy.source.maximum_characters < 1
  ) {
    errors.push('Invalid source resolution limits');
  }
  if (policy.candidates.per_mode_limit < 1 || policy.review.batch_size < 1) {
    errors.push('Invalid analysis batch limits');
  }
  const ontology = dataset.semanticOntology;
  if (
    !ontology.claim_roles.includes('other') ||
    !ontology.directions.includes('none') ||
    !Object.hasOwn(ontology.domains, 'other') ||
    !Object.hasOwn(ontology.operations, 'other') ||
    !Object.hasOwn(ontology.affected_states, 'other')
  ) {
    errors.push('Semantic ontology must provide explicit fallback values');
  }
}

function validateEvidence(
  evidence: Evidence,
  owner: string,
  expectedRevision: number,
  errors: string[],
): void {
  if (!Number.isInteger(evidence.revision) || evidence.revision < 0) {
    errors.push(`Invalid evidence revision: ${owner}`);
  }
  if (!evidence.section.trim() || !evidence.locator.trim()) {
    errors.push(`Incomplete evidence: ${owner}`);
  }
  if (evidence.revision !== expectedRevision) {
    errors.push(`Evidence revision mismatch: ${owner}`);
  }
}

function validateChunkReferences(
  chunkIds: string[],
  analyzedChunkIds: string[],
  owner: string,
  errors: string[],
): void {
  if (chunkIds.length === 0) {
    errors.push(`Missing analyzed chunk reference: ${owner}`);
    return;
  }
  const analyzed = new Set(analyzedChunkIds);
  if (chunkIds.some((chunkId) => !analyzed.has(chunkId))) {
    errors.push(`Unknown analyzed chunk reference: ${owner}`);
  }
}
