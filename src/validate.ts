import { IsorropiaEngine } from './engine.js';
import { DISCLAIMER, MODES, type Dataset, type Evidence } from './types.js';
import { calculateDatabaseVersion } from './version.js';

export type ValidationResult = {
  valid: boolean;
  errors: string[];
};

export function validateDataset(dataset: Dataset): ValidationResult {
  const errors: string[] = [];
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
    if (!profileIds.has(edge.from) || !profileIds.has(edge.to)) {
      errors.push(`Edge references unknown profile: ${edge.from} -> ${edge.to}`);
    }
    validateEvidence(edge.evidence, `${edge.from} -> ${edge.to}`, edge.evidence.revision, errors);
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
    if (semantic.reviewed_modes) {
      const reviewed = new Set(semantic.reviewed_modes);
      if (reviewed.size !== semantic.reviewed_modes.length) {
        errors.push(`Duplicate reviewed mode: ${semantic.page_id}`);
      }
      for (const mode of semantic.reviewed_modes) {
        if (!MODES.includes(mode)) {
          errors.push(`Invalid reviewed mode: ${semantic.page_id}/${mode}`);
        }
      }
    }
    const claimIds = new Set<string>();
    for (const claim of semantic.claims) {
      if (!claim.id.trim() || claimIds.has(claim.id)) {
        errors.push(`Invalid or duplicate semantic claim: ${semantic.page_id}/${claim.id}`);
      }
      claimIds.add(claim.id);
      if (claim.evidence.length === 0) {
        errors.push(`Semantic claim has no evidence: ${semantic.page_id}/${claim.id}`);
      }
      for (const evidence of claim.evidence) {
        validateEvidence(evidence, `${semantic.page_id}/${claim.id}`, semantic.source_revision, errors);
      }
    }
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

  if (dataset.manifest.profile_count !== dataset.profiles.length) {
    errors.push('Manifest profile_count does not match profiles');
  }
  if (
    dataset.manifest.database_version !==
    calculateDatabaseVersion(
      dataset.profiles,
      dataset.edges,
      dataset.semantics,
      dataset.interactions,
    )
  ) {
    errors.push('Manifest database_version does not match profiles and edges');
  }
  if (dataset.manifest.attributions.length !== dataset.profiles.length) {
    errors.push('Manifest attribution count does not match profiles');
  }
  const attributed = new Set(dataset.manifest.attributions.map((entry) => entry.page_id));
  for (const pageId of profileIds) {
    if (!attributed.has(pageId)) errors.push(`Missing attribution: ${pageId}`);
  }

  if (dataset.golden.length < 10) {
    errors.push(`Expected at least 10 reviewed golden cases, got ${dataset.golden.length}`);
  }
  const goldenIds = new Set<string>();
  const engine = errors.length === 0 ? new IsorropiaEngine(dataset) : undefined;
  for (const golden of dataset.golden) {
    if (goldenIds.has(golden.id)) errors.push(`Duplicate golden case: ${golden.id}`);
    goldenIds.add(golden.id);
    if (!profileIds.has(golden.left) || !profileIds.has(golden.right)) {
      errors.push(`Golden case references unknown profile: ${golden.id}`);
      continue;
    }
    if (!engine) continue;
    const results = engine
      .pair({ pageId: golden.left, mode: golden.mode, limit: 99 })
      .results;
    const rank = results.findIndex((candidate) => candidate.page_id === golden.right);
    const result = rank >= 0 ? results[rank] : undefined;
    if (golden.expectation === 'exclude') {
      if (result) errors.push(`Excluded golden case was returned: ${golden.id}`);
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

export function validateGoldenRankings(dataset: Dataset): string[] {
  const errors: string[] = [];
  const profileIds = new Set(dataset.profiles.map((profile) => profile.page_id));
  const engine = new IsorropiaEngine(dataset);
  for (const golden of dataset.golden) {
    if (!profileIds.has(golden.left) || !profileIds.has(golden.right)) continue;
    const results = engine
      .pair({ pageId: golden.left, mode: golden.mode, limit: 99 })
      .results;
    const rank = results.findIndex((candidate) => candidate.page_id === golden.right);
    const result = rank >= 0 ? results[rank] : undefined;
    if (golden.expectation === 'exclude') {
      if (result) errors.push(`Excluded golden case was returned: ${golden.id}`);
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
