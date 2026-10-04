import type {
  Effect,
  ReadingProfile,
  SemanticOntology,
  SemanticProfile,
} from './types.js';

export function compileProfileEffects(
  semantic: SemanticProfile,
  ontology: SemanticOntology,
): Effect[] {
  const operationalClaims = semantic.claims.filter((claim) => claim.kind !== 'narrative');
  const effects = (operationalClaims.length > 0 ? operationalClaims : semantic.claims.slice(0, 1))
    .flatMap((claim) => {
      const evidence = claim.evidence[0];
      if (!evidence) return [];
      return [{
        domain: canonicalOntologyClass(
          claim.domain_class,
          ontology.domains,
        ).canonical,
        operation: canonicalOntologyClass(
          claim.operation_class,
          ontology.operations,
        ).canonical,
        target: claim.target ?? claim.subject ?? claim.outcomes[0] ?? 'article-specific-subject',
        trigger: claim.trigger ?? claim.preconditions[0] ?? 'article-defined-condition',
        persistence: claim.persistence ?? 'article-defined',
        constraints: unique([...claim.preconditions, ...claim.limitations]),
        evidence,
      }];
    });
  if (effects.length === 0) {
    throw new Error(`No profile effects can be derived for ${semantic.page_id}`);
  }
  return effects;
}

export function compileReadingThemes(
  reading: ReadingProfile | undefined,
): string[] {
  return unique((reading?.themes ?? []).map(normalizeToken));
}

export function canonicalOntologyClass(
  value: string,
  groups: Record<string, string[]>,
): { canonical: string; raw?: string } {
  const normalized = value.trim().toLowerCase();
  for (const [canonical, aliases] of Object.entries(groups)) {
    if (canonical === normalized || aliases.includes(normalized)) return { canonical };
  }
  return { canonical: 'other', raw: value.trim() };
}

export function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
