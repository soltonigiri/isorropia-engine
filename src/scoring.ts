import type {
  Edge,
  Evidence,
  MatchedRule,
  Mode,
  PairResult,
  Profile,
  Rule,
  RuleMatcher,
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
}): PairResult {
  const context: MatchContext = {
    left: params.query,
    right: params.candidate,
    edges: params.edges,
  };
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
  const linked = hasExplicitLink(context);
  const score = Math.min(100, Math.round(rawScore * 5));
  const confidence = round(
    Math.min(
      0.99,
      0.25 + rawScore / 40 + Math.min(0.15, matched.length * 0.03) +
        (linked ? 0.08 : 0),
    ),
  );
  const strongestRule = [...matchedRules].sort(
    (left, right) => right.weight - left.weight || left.id.localeCompare(right.id),
  )[0];
  const evidence = strongestRule
    ? evidenceForMatcher(strongestRule.matcher, context)
    : undefined;

  return {
    page_id: params.candidate.page_id,
    title: params.candidate.title,
    url: params.candidate.url,
    score,
    confidence,
    rules: matched,
    evidence: {
      query: evidence?.query ?? params.query.effects[0]!.evidence,
      candidate: evidence?.candidate ?? params.candidate.effects[0]!.evidence,
    },
  };
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
  const left = leftProfile.effects.find((effect) =>
    leftOperations.includes(effect.operation),
  );
  const right = rightProfile.effects.find((effect) =>
    rightOperations.includes(effect.operation),
  );
  return left && right ? [left, right] : undefined;
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

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
