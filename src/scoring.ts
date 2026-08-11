import type {
  Edge,
  Evidence,
  AcceptedInteraction,
  MatchedRule,
  Mode,
  PairInteraction,
  PairResult,
  Profile,
  Rule,
  RuleMatcher,
  SemanticProfile,
} from './types.js';

const IGNORED_SHARED_TAGS = new Set([
  'scp',
  'safe',
  'euclid',
  'keter',
  'esoteric-class',
  'illustrated',
  'featured',
  'co-authored',
  'rewrite',
]);

function isSubstantiveTag(tag: string): boolean {
  return !tag.startsWith('_') && !IGNORED_SHARED_TAGS.has(tag);
}

type MatchContext = {
  left: Profile;
  right: Profile;
  edges: Edge[];
};

export function scorePair(params: {
  query: Profile;
  candidate: Profile;
  mode: Mode;
  rules: Rule[];
  edges: Edge[];
  interaction?: PairInteraction;
  semantics?: Map<string, SemanticProfile>;
}): PairResult | undefined {
  const context: MatchContext = {
    left: params.query,
    right: params.candidate,
    edges: params.edges,
  };
  if (params.interaction) {
    if (!isCurrentInteraction(params.interaction, context)) return undefined;
    if (params.interaction.verdict === 'rejected') return undefined;
    return scoreAcceptedInteraction(
      params.interaction,
      context,
      params.semantics ?? new Map(),
    );
  }

  const matchedRules = params.rules
    .filter((rule) => rule.mode === params.mode)
    .filter((rule) => matches(rule.matcher, context));
  const matched = matchedRules
    .map<MatchedRule>((rule) => ({
      id: rule.id,
      weight: rule.weight,
      explanation: rule.description,
    }));

  const rawScore = matched.reduce((sum, rule) => sum + rule.weight, 0);
  if (rawScore === 0) return undefined;
  const strongestRule = [...matchedRules].sort(
    (left, right) => right.weight - left.weight || left.id.localeCompare(right.id),
  )[0];
  const evidence = strongestRule
    ? evidenceForMatcher(strongestRule.matcher, context)
    : undefined;
  const queryEvidence = evidence?.query ?? params.query.effects[0]!.evidence;
  const candidateEvidence = evidence?.candidate ?? params.candidate.effects[0]!.evidence;
  const sourceEvidenceCount = [queryEvidence, candidateEvidence].filter(
    (item) => item.section !== 'metadata.tags',
  ).length;
  const scoreCap = sourceEvidenceCount === 2 ? 100 : sourceEvidenceCount === 1 ? 60 : 35;
  const score = Math.min(scoreCap, Math.min(100, Math.round(rawScore * 5)));
  const confidence = sourceEvidenceCount === 2
    ? 0.75
    : sourceEvidenceCount === 1
      ? 0.45
      : 0.3;

  return {
    page_id: params.candidate.page_id,
    title: params.candidate.title,
    url: params.candidate.url,
    score,
    confidence,
    rules: matched,
    evidence: {
      query: queryEvidence,
      candidate: candidateEvidence,
    },
  };
}

function scoreAcceptedInteraction(
  interaction: AcceptedInteraction,
  context: MatchContext,
  semantics: Map<string, SemanticProfile>,
): PairResult {
  const score =
    rubricPoints.mode_fit[interaction.rubric.mode_fit] +
    rubricPoints.coherence[interaction.rubric.coherence] +
    rubricPoints.specificity[interaction.rubric.specificity] +
    rubricPoints.discovery_value[interaction.rubric.discovery_value];
  const queryEvidence = evidenceForClaim(
    semantics,
    context.left.page_id,
    interaction.claim_refs[context.left.page_id]?.[0],
  );
  const candidateEvidence = evidenceForClaim(
    semantics,
    context.right.page_id,
    interaction.claim_refs[context.right.page_id]?.[0],
  );
  return {
    page_id: context.right.page_id,
    title: context.right.title,
    url: context.right.url,
    score,
    confidence: supportConfidence[interaction.support],
    rules: [
      {
        id: interaction.id,
        weight: 100,
        explanation: interaction.explanation,
      },
    ],
    evidence: {
      query: queryEvidence ?? context.left.effects[0]!.evidence,
      candidate: candidateEvidence ?? context.right.effects[0]!.evidence,
    },
    causal_chain: interaction.causal_chain,
    ...(interaction.assumption ? { assumption: interaction.assumption } : {}),
    ...(interaction.limitation ? { limitation: interaction.limitation } : {}),
  };
}

const rubricPoints = {
  mode_fit: { core: 35, strong: 30, partial: 20 },
  coherence: { complete: 30, conditional: 20, thematic: 10 },
  specificity: { 'article-specific': 20, 'domain-specific': 12, generic: 5 },
  discovery_value: { high: 15, medium: 10, low: 5 },
} as const;

const supportConfidence = { A: 0.9, B: 0.75, C: 0.55, D: 0.3 } as const;

function isCurrentInteraction(
  interaction: PairInteraction,
  context: MatchContext,
): boolean {
  return [context.left, context.right].every(
    (profile) =>
      interaction.source_revisions[profile.page_id] === profile.source_revision,
  );
}

function evidenceForClaim(
  semantics: Map<string, SemanticProfile>,
  pageId: string,
  claimId: string | undefined,
): Evidence | undefined {
  if (!claimId) return undefined;
  return semantics
    .get(pageId)
    ?.claims.find((claim) => claim.id === claimId)
    ?.evidence[0];
}

function evidenceForMatcher(
  matcher: RuleMatcher,
  context: MatchContext,
): { query: Evidence; candidate: Evidence } | undefined {
  if (matcher.type === 'operation_pair') {
    const direct = findOperationPair(matcher.left, matcher.right, context.left, context.right);
    if (direct) return { query: direct[0].evidence, candidate: direct[1].evidence };
    const reverse = findOperationPair(matcher.right, matcher.left, context.left, context.right);
    if (reverse) return { query: reverse[0].evidence, candidate: reverse[1].evidence };
  }
  if (
    matcher.type === 'same_domain' ||
    matcher.type === 'different_operation_same_domain'
  ) {
    for (const left of context.left.effects) {
      const right = context.right.effects.find(
        (effect) =>
          effect.domain === left.domain &&
          (matcher.type === 'same_domain' || effect.operation !== left.operation),
      );
      if (right) return { query: left.evidence, candidate: right.evidence };
    }
  }
  if (matcher.type === 'shared_tag' || matcher.type === 'shared_theme') {
    const leftValues = matcher.type === 'shared_tag'
      ? context.left.tags.filter(isSubstantiveTag)
      : context.left.themes;
    const rightValues = matcher.type === 'shared_tag'
      ? context.right.tags.filter(isSubstantiveTag)
      : context.right.themes;
    const common = intersection(leftValues, rightValues).sort()[0];
    if (common) {
      return {
        query: metadataEvidence(context.left, common),
        candidate: metadataEvidence(context.right, common),
      };
    }
  }
  return undefined;
}

function findOperationPair(
  leftOperations: string[],
  rightOperations: string[],
  leftProfile: Profile,
  rightProfile: Profile,
): [Profile['effects'][number], Profile['effects'][number]] | undefined {
  const left = preferredEffect(leftProfile, leftOperations);
  const right = preferredEffect(rightProfile, rightOperations);
  return left && right ? [left, right] : undefined;
}

function preferredEffect(profile: Profile, operations: string[]): Profile['effects'][number] | undefined {
  return profile.effects
    .filter((effect) => operations.includes(effect.operation))
    .sort(
      (left, right) =>
        Number(left.evidence.section === 'metadata.tags') -
        Number(right.evidence.section === 'metadata.tags'),
    )[0];
}

function metadataEvidence(profile: Profile, tag: string): Evidence {
  return {
    revision: profile.source_revision,
    section: 'metadata.tags',
    locator: `tag:${tag}`,
  };
}

function matches(matcher: RuleMatcher, context: MatchContext): boolean {
  switch (matcher.type) {
    case 'operation_pair':
      return matchesOperationPair(matcher.left, matcher.right, context);
    case 'same_domain':
      return context.left.effects.some((left) =>
        context.right.effects.some((right) => left.domain === right.domain),
      );
    case 'different_operation_same_domain':
      return context.left.effects.some((left) =>
        context.right.effects.some(
          (right) =>
            left.domain === right.domain && left.operation !== right.operation,
        ),
      );
    case 'shared_tag':
      return intersection(
        context.left.tags.filter(isSubstantiveTag),
        context.right.tags.filter(isSubstantiveTag),
      ).length >= matcher.minimum;
    case 'shared_theme':
      return intersection(context.left.themes, context.right.themes).length >= matcher.minimum;
    case 'same_trigger':
      return context.left.effects.some((left) =>
        context.right.effects.some(
          (right) => left.trigger !== 'passive' && left.trigger === right.trigger,
        ),
      );
    case 'same_persistence':
      return context.left.effects.some((left) =>
        context.right.effects.some(
          (right) =>
            left.persistence !== 'variable' &&
            left.persistence === right.persistence,
        ),
      );
    case 'same_series':
      return Boolean(
        context.left.series && context.left.series === context.right.series,
      );
    case 'explicit_link':
      return hasExplicitLink(context);
  }
}

function matchesOperationPair(
  leftOperations: string[],
  rightOperations: string[],
  context: MatchContext,
): boolean {
  const left = new Set(context.left.effects.map((effect) => effect.operation));
  const right = new Set(context.right.effects.map((effect) => effect.operation));
  return (
    (leftOperations.some((operation) => left.has(operation)) &&
      rightOperations.some((operation) => right.has(operation))) ||
    (leftOperations.some((operation) => right.has(operation)) &&
      rightOperations.some((operation) => left.has(operation)))
  );
}

function hasExplicitLink(context: MatchContext): boolean {
  return context.edges.some(
    (edge) =>
      edge.type === 'explicit_link' &&
      ((edge.from === context.left.page_id && edge.to === context.right.page_id) ||
        (edge.from === context.right.page_id && edge.to === context.left.page_id)),
  );
}

function intersection(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return Array.from(new Set(left.filter((value) => rightSet.has(value))));
}
