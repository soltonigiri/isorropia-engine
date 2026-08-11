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

  if (dataset.profiles.length !== 100) {
    errors.push(`Expected 100 profiles, got ${dataset.profiles.length}`);
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

  if (dataset.manifest.profile_count !== dataset.profiles.length) {
    errors.push('Manifest profile_count does not match profiles');
  }
  if (
    dataset.manifest.database_version !==
    calculateDatabaseVersion(dataset.profiles, dataset.edges)
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

  if (dataset.golden.length < 50) {
    errors.push(`Expected at least 50 golden cases, got ${dataset.golden.length}`);
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
    const result = engine
      .pair({ pageId: golden.left, mode: golden.mode, limit: 99 })
      .results.find((candidate) => candidate.page_id === golden.right);
    if (!result || result.score < golden.minimum_score) {
      errors.push(`Golden case score below minimum: ${golden.id}`);
      continue;
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
        if (response.results.length !== 5) {
          errors.push(`Default result count is not 5: ${profile.page_id}/${mode}`);
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
