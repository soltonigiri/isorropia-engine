import { MODES } from './types.js';

type JsonObject = Record<string, unknown>;

export type DatasetFileKind =
  | 'profile'
  | 'rules'
  | 'manifest'
  | 'golden'
  | 'semantics'
  | 'interactions'
  | 'selection-policy'
  | 'scoring-policy'
  | 'semantic-ontology'
  | 'analysis-policy'
  | 'edge';

export function assertDatasetFile(
  value: unknown,
  kind: DatasetFileKind,
  filePath: string,
): void {
  const fail = (jsonPath: string, expected: string): never => {
    throw new Error(`${filePath}:${jsonPath}: expected ${expected}`);
  };
  const object = (item: unknown, jsonPath: string): JsonObject => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return fail(jsonPath, 'object');
    }
    return item as JsonObject;
  };
  const array = (item: unknown, jsonPath: string): unknown[] => {
    if (!Array.isArray(item)) return fail(jsonPath, 'array');
    return item;
  };
  const string = (item: unknown, jsonPath: string): string => {
    if (typeof item !== 'string') return fail(jsonPath, 'string');
    return item;
  };
  const nonempty = (item: unknown, jsonPath: string): string => {
    const result = string(item, jsonPath);
    if (!result.trim()) return fail(jsonPath, 'non-empty string');
    return result;
  };
  const number = (item: unknown, jsonPath: string): number => {
    if (typeof item !== 'number' || !Number.isFinite(item)) {
      return fail(jsonPath, 'finite number');
    }
    return item;
  };
  const integer = (item: unknown, jsonPath: string): number => {
    const result = number(item, jsonPath);
    if (!Number.isInteger(result)) return fail(jsonPath, 'integer');
    return result;
  };
  const boolean = (item: unknown, jsonPath: string): boolean => {
    if (typeof item !== 'boolean') return fail(jsonPath, 'boolean');
    return item;
  };
  const enumValue = <T extends string>(
    item: unknown,
    jsonPath: string,
    values: readonly T[],
  ): T => {
    const result = string(item, jsonPath);
    if (!values.includes(result as T)) return fail(jsonPath, values.join(' | '));
    return result as T;
  };
  const strings = (item: unknown, jsonPath: string): void => {
    array(item, jsonPath).forEach((entry, index) => string(entry, `${jsonPath}[${index}]`));
  };
  const twoStrings = (item: unknown, jsonPath: string): void => {
    const values = array(item, jsonPath);
    if (values.length !== 2) fail(jsonPath, 'two strings');
    values.forEach((entry, index) => nonempty(entry, `${jsonPath}[${index}]`));
  };
  const proofLinks = (item: unknown, jsonPath: string): void => {
    array(item, jsonPath).forEach((linkValue, index) => {
      const link = object(linkValue, `${jsonPath}[${index}]`);
      for (const key of ['from_page', 'from_claim', 'to_page', 'to_claim', 'relation']) {
        nonempty(link[key], `${jsonPath}[${index}].${key}`);
      }
    });
  };
  const optionalString = (record: JsonObject, key: string, jsonPath: string): void => {
    if (record[key] !== undefined) string(record[key], `${jsonPath}.${key}`);
  };
  const recordOfStringArrays = (item: unknown, jsonPath: string): void => {
    const record = object(item, jsonPath);
    for (const [key, values] of Object.entries(record)) {
      nonempty(key, jsonPath);
      strings(values, `${jsonPath}.${key}`);
    }
  };
  const evidence = (item: unknown, jsonPath: string): void => {
    const record = object(item, jsonPath);
    integer(record.revision, `${jsonPath}.revision`);
    nonempty(record.section, `${jsonPath}.section`);
    nonempty(record.locator, `${jsonPath}.locator`);
  };
  const profile = (item: unknown, jsonPath: string): void => {
    const record = object(item, jsonPath);
    nonempty(record.page_id, `${jsonPath}.page_id`);
    integer(record.scp_number, `${jsonPath}.scp_number`);
    nonempty(record.wikidot_page_id, `${jsonPath}.wikidot_page_id`);
    nonempty(record.title, `${jsonPath}.title`);
    nonempty(record.url, `${jsonPath}.url`);
    strings(record.authors, `${jsonPath}.authors`);
    enumValue(record.language, `${jsonPath}.language`, ['en']);
    integer(record.source_revision, `${jsonPath}.source_revision`);
    strings(record.tags, `${jsonPath}.tags`);
    strings(record.themes, `${jsonPath}.themes`);
    if (boolean(record.curated, `${jsonPath}.curated`) !== true) {
      fail(`${jsonPath}.curated`, 'true');
    }
    array(record.effects, `${jsonPath}.effects`).forEach((effectValue, index) => {
      const effectRecord = object(effectValue, `${jsonPath}.effects[${index}]`);
      for (const key of ['domain', 'operation', 'target', 'trigger', 'persistence'] as const) {
        nonempty(effectRecord[key], `${jsonPath}.effects[${index}].${key}`);
      }
      strings(effectRecord.constraints, `${jsonPath}.effects[${index}].constraints`);
      evidence(effectRecord.evidence, `${jsonPath}.effects[${index}].evidence`);
    });
  };
  const semantic = (item: unknown, jsonPath: string): void => {
    const record = object(item, jsonPath);
    nonempty(record.page_id, `${jsonPath}.page_id`);
    integer(record.source_revision, `${jsonPath}.source_revision`);
    array(record.claims, `${jsonPath}.claims`).forEach((claimValue, index) => {
      const claimPath = `${jsonPath}.claims[${index}]`;
      const claim = object(claimValue, claimPath);
      nonempty(claim.id, `${claimPath}.id`);
      enumValue(claim.kind, `${claimPath}.kind`, ['effect', 'dependency', 'narrative']);
      nonempty(claim.domain, `${claimPath}.domain`);
      nonempty(claim.operation, `${claimPath}.operation`);
      for (const key of ['subject', 'target', 'vector', 'trigger', 'scope', 'persistence']) {
        optionalString(claim, key, claimPath);
      }
      strings(claim.outcomes, `${claimPath}.outcomes`);
      strings(claim.preconditions, `${claimPath}.preconditions`);
      strings(claim.limitations, `${claimPath}.limitations`);
      array(claim.evidence, `${claimPath}.evidence`).forEach((entry, evidenceIndex) =>
        evidence(entry, `${claimPath}.evidence[${evidenceIndex}]`),
      );
      for (const key of [
        'role', 'operation_class', 'domain_class', 'affected_state', 'direction',
      ]) nonempty(claim[key], `${claimPath}.${key}`);
      for (const key of ['raw_operation', 'raw_domain']) optionalString(claim, key, claimPath);
      strings(claim.chunk_ids, `${claimPath}.chunk_ids`);
    });
    if (record.reading !== undefined) {
      const reading = object(record.reading, `${jsonPath}.reading`);
      for (const key of ['themes', 'forms', 'structures', 'tones', 'motifs']) {
        strings(reading[key], `${jsonPath}.reading.${key}`);
      }
      if (reading.moves !== undefined) {
        array(reading.moves, `${jsonPath}.reading.moves`).forEach((moveValue, index) => {
          const move = object(moveValue, `${jsonPath}.reading.moves[${index}]`);
          enumValue(move.kind, `${jsonPath}.reading.moves[${index}].kind`, [
            'premise', 'escalation', 'reversal', 'reframing', 'ending',
          ]);
          nonempty(move.description, `${jsonPath}.reading.moves[${index}].description`);
          strings(move.chunk_ids, `${jsonPath}.reading.moves[${index}].chunk_ids`);
          array(move.evidence, `${jsonPath}.reading.moves[${index}].evidence`)
            .forEach((entry, evidenceIndex) => evidence(
              entry,
              `${jsonPath}.reading.moves[${index}].evidence[${evidenceIndex}]`,
            ));
        });
      }
    }
    if (integer(record.schema_version, `${jsonPath}.schema_version`) !== 2) {
      fail(`${jsonPath}.schema_version`, '2');
    }
    nonempty(record.semantic_policy_digest, `${jsonPath}.semantic_policy_digest`);
    const coverage = object(record.coverage, `${jsonPath}.coverage`);
    enumValue(coverage.status, `${jsonPath}.coverage.status`, ['complete', 'partial']);
    nonempty(coverage.source_digest, `${jsonPath}.coverage.source_digest`);
    strings(coverage.analyzed_chunk_ids, `${jsonPath}.coverage.analyzed_chunk_ids`);
    strings(coverage.unresolved_features, `${jsonPath}.coverage.unresolved_features`);
    array(record.reviewed_modes, `${jsonPath}.reviewed_modes`).forEach((mode, index) =>
      enumValue(mode, `${jsonPath}.reviewed_modes[${index}]`, MODES),
    );
  };
  const interaction = (item: unknown, jsonPath: string): void => {
    const record = object(item, jsonPath);
    nonempty(record.id, `${jsonPath}.id`);
    const pages = array(record.pages, `${jsonPath}.pages`);
    if (pages.length !== 2) fail(`${jsonPath}.pages`, 'two page ids');
    pages.forEach((pageId, index) => nonempty(pageId, `${jsonPath}.pages[${index}]`));
    enumValue(record.mode, `${jsonPath}.mode`, MODES);
    const revisions = object(record.source_revisions, `${jsonPath}.source_revisions`);
    for (const pageId of pages as string[]) {
      integer(revisions[pageId], `${jsonPath}.source_revisions.${pageId}`);
    }
    const verdict = enumValue(record.verdict, `${jsonPath}.verdict`, ['accepted', 'rejected']);
    const digests = object(record.semantic_digests, `${jsonPath}.semantic_digests`);
    for (const pageId of pages as string[]) {
      nonempty(digests[pageId], `${jsonPath}.semantic_digests.${pageId}`);
    }
    nonempty(record.candidate_policy_digest, `${jsonPath}.candidate_policy_digest`);
    nonempty(record.review_policy_digest, `${jsonPath}.review_policy_digest`);
    if (verdict === 'rejected') {
      nonempty(record.reason, `${jsonPath}.reason`);
      return;
    }
    nonempty(record.mechanism, `${jsonPath}.mechanism`);
    const claimRefs = object(record.claim_refs, `${jsonPath}.claim_refs`);
    for (const pageId of pages as string[]) {
      strings(claimRefs[pageId], `${jsonPath}.claim_refs.${pageId}`);
    }
    strings(record.causal_chain, `${jsonPath}.causal_chain`);
    nonempty(record.explanation, `${jsonPath}.explanation`);
    const rubric = object(record.rubric, `${jsonPath}.rubric`);
    enumValue(rubric.mode_fit, `${jsonPath}.rubric.mode_fit`, ['core', 'strong', 'partial']);
    enumValue(rubric.coherence, `${jsonPath}.rubric.coherence`, ['complete', 'conditional', 'thematic']);
    enumValue(rubric.specificity, `${jsonPath}.rubric.specificity`, ['article-specific', 'domain-specific', 'generic']);
    enumValue(rubric.discovery_value, `${jsonPath}.rubric.discovery_value`, ['high', 'medium', 'low']);
    enumValue(record.support, `${jsonPath}.support`, ['A', 'B', 'C']);
    const proof = object(record.proof, `${jsonPath}.proof`);
    const proofMode = enumValue(proof.mode, `${jsonPath}.proof.mode`, MODES);
    strings(proof.bridge_assumptions, `${jsonPath}.proof.bridge_assumptions`);
    if (proofMode === 'cycle') {
      const pattern = enumValue(proof.pattern, `${jsonPath}.proof.pattern`, [
        'mutual-counteraction', 'shared-state-balance',
      ]);
      proofLinks(proof.links, `${jsonPath}.proof.links`);
      if (pattern === 'shared-state-balance') {
        nonempty(proof.shared_state, `${jsonPath}.proof.shared_state`);
        twoStrings(proof.directions, `${jsonPath}.proof.directions`);
      }
    } else if (proofMode === 'breach') {
      enumValue(proof.relation, `${jsonPath}.proof.relation`, [
        'activates', 'disables-safeguard', 'propagates', 'increases-reach',
        'increases-severity', 'increases-duration', 'removes-required-resource',
      ]);
      twoStrings(proof.direction, `${jsonPath}.proof.direction`);
      proofLinks(proof.links, `${jsonPath}.proof.links`);
    } else {
      enumValue(proof.relation, `${jsonPath}.proof.relation`, [
        'contrast', 'inversion', 'progression', 'reframing',
      ]);
      const anchors = array(proof.anchors, `${jsonPath}.proof.anchors`);
      if (anchors.length !== 2) fail(`${jsonPath}.proof.anchors`, 'two article anchors');
      anchors.forEach((anchorValue, index) => {
        const anchor = object(anchorValue, `${jsonPath}.proof.anchors[${index}]`);
        nonempty(anchor.page_id, `${jsonPath}.proof.anchors[${index}].page_id`);
        strings(anchor.claim_refs, `${jsonPath}.proof.anchors[${index}].claim_refs`);
      });
      if (proof.reading_order !== 'order-neutral') {
        twoStrings(proof.reading_order, `${jsonPath}.proof.reading_order`);
      }
      nonempty(proof.ordering_gain, `${jsonPath}.proof.ordering_gain`);
      nonempty(proof.replacement_test, `${jsonPath}.proof.replacement_test`);
    }
  };

  switch (kind) {
    case 'profile':
      profile(value, '$');
      return;
    case 'rules':
      array(value, '$').forEach((entry, index) => {
        const record = object(entry, `$[${index}]`);
        nonempty(record.id, `$[${index}].id`);
        enumValue(record.mode, `$[${index}].mode`, MODES);
        number(record.weight, `$[${index}].weight`);
        nonempty(record.description, `$[${index}].description`);
        const matcherPath = `$[${index}].matcher`;
        const matcher = object(record.matcher, matcherPath);
        const matcherType = enumValue(matcher.type, `${matcherPath}.type`, [
          'operation_pair', 'same_domain', 'different_operation_same_domain',
          'shared_tag', 'shared_theme', 'same_trigger', 'same_persistence',
          'same_series', 'explicit_link',
        ]);
        if (matcherType === 'operation_pair') {
          strings(matcher.left, `${matcherPath}.left`);
          strings(matcher.right, `${matcherPath}.right`);
        }
        if (matcherType === 'shared_tag' || matcherType === 'shared_theme') {
          integer(matcher.minimum, `${matcherPath}.minimum`);
        }
      });
      return;
    case 'manifest': {
      const record = object(value, '$');
      nonempty(record.database_version, '$.database_version');
      nonempty(record.generated_at, '$.generated_at');
      nonempty(record.source, '$.source');
      integer(record.profile_count, '$.profile_count');
      array(record.attributions, '$.attributions').forEach((entry, index) => {
        const attribution = object(entry, `$.attributions[${index}]`);
        nonempty(attribution.page_id, `$.attributions[${index}].page_id`);
        nonempty(attribution.title, `$.attributions[${index}].title`);
        nonempty(attribution.url, `$.attributions[${index}].url`);
        strings(attribution.authors, `$.attributions[${index}].authors`);
        integer(attribution.revision, `$.attributions[${index}].revision`);
        enumValue(attribution.license, `$.attributions[${index}].license`, ['CC BY-SA 3.0']);
        enumValue(attribution.status, `$.attributions[${index}].status`, ['verified', 'unresolved']);
      });
      return;
    }
    case 'golden':
      array(value, '$').forEach((entry, index) => {
        const record = object(entry, `$[${index}]`);
        nonempty(record.id, `$[${index}].id`);
        enumValue(record.mode, `$[${index}].mode`, MODES);
        nonempty(record.left, `$[${index}].left`);
        const expectation = record.expectation === undefined
          ? 'include'
          : enumValue(record.expectation, `$[${index}].expectation`, ['include', 'exclude', 'empty']);
        if (expectation !== 'empty') nonempty(record.right, `$[${index}].right`);
        if (record.minimum_score !== undefined) number(record.minimum_score, `$[${index}].minimum_score`);
        if (record.maximum_rank !== undefined) integer(record.maximum_rank, `$[${index}].maximum_rank`);
        if (record.required_rule !== undefined) nonempty(record.required_rule, `$[${index}].required_rule`);
      });
      return;
    case 'semantics':
      array(value, '$').forEach((entry, index) => semantic(entry, `$[${index}]`));
      return;
    case 'interactions':
      array(value, '$').forEach((entry, index) => interaction(entry, `$[${index}]`));
      return;
    case 'selection-policy': {
      const record = object(value, '$');
      integer(record.version, '$.version');
      integer(record.weekly_analysis_limit, '$.weekly_analysis_limit');
      const eligibility = object(record.eligibility, '$.eligibility');
      enumValue(eligibility.domain, '$.eligibility.domain', ['scp-wiki.wikidot.com']);
      nonempty(eligibility.required_tag, '$.eligibility.required_tag');
      number(eligibility.minimum_rating, '$.eligibility.minimum_rating');
      integer(eligibility.minimum_age_days, '$.eligibility.minimum_age_days');
      for (const key of ['require_content_file', 'require_attribution']) {
        if (boolean(eligibility[key], `$.eligibility.${key}`) !== true) {
          fail(`$.eligibility.${key}`, 'true');
        }
      }
      const weights = object(record.weights, '$.weights');
      for (const key of [
        'rating_percentile', 'tag_novelty', 'reference_adjacency',
        'series_underrepresentation',
      ]) number(weights[key], `$.weights.${key}`);
      return;
    }
    case 'scoring-policy': {
      const record = object(value, '$');
      integer(record.version, '$.version');
      const thresholds = object(record.setting_thresholds, '$.setting_thresholds');
      for (const key of ['rough', 'coarse', '1:1', 'fine', 'very-fine']) {
        number(thresholds[key], `$.setting_thresholds.${key}`);
      }
      const rubric = object(record.rubric_points, '$.rubric_points');
      for (const [group, keys] of Object.entries({
        mode_fit: ['core', 'strong', 'partial'],
        coherence: ['complete', 'conditional', 'thematic'],
        specificity: ['article-specific', 'domain-specific', 'generic'],
        discovery_value: ['high', 'medium', 'low'],
      })) {
        const values = object(rubric[group], `$.rubric_points.${group}`);
        for (const key of keys) number(values[key], `$.rubric_points.${group}.${key}`);
      }
      const support = object(record.support_confidence, '$.support_confidence');
      for (const key of ['A', 'B', 'C']) number(support[key], `$.support_confidence.${key}`);
      const fallback = object(record.fallback, '$.fallback');
      for (const key of ['article_both', 'article_one', 'metadata_only']) {
        const values = object(fallback[key], `$.fallback.${key}`);
        number(values.score_cap, `$.fallback.${key}.score_cap`);
        number(values.confidence, `$.fallback.${key}.confidence`);
      }
      const tieBreak = array(record.tie_break, '$.tie_break');
      if (JSON.stringify(tieBreak) !== JSON.stringify(['score-desc', 'confidence-desc', 'page-id-asc'])) {
        fail('$.tie_break', 'score-desc, confidence-desc, page-id-asc');
      }
      return;
    }
    case 'semantic-ontology': {
      const record = object(value, '$');
      integer(record.version, '$.version');
      strings(record.claim_roles, '$.claim_roles');
      strings(record.directions, '$.directions');
      strings(record.reading_moves, '$.reading_moves');
      recordOfStringArrays(record.domains, '$.domains');
      recordOfStringArrays(record.operations, '$.operations');
      recordOfStringArrays(record.affected_states, '$.affected_states');
      return;
    }
    case 'analysis-policy': {
      const record = object(value, '$');
      integer(record.version, '$.version');
      const source = object(record.source, '$.source');
      for (const key of ['maximum_depth', 'maximum_segments', 'maximum_characters']) {
        integer(source[key], `$.source.${key}`);
      }
      const candidates = object(record.candidates, '$.candidates');
      integer(candidates.per_mode_limit, '$.candidates.per_mode_limit');
      const weights = object(candidates.mode_weights, '$.candidates.mode_weights');
      for (const mode of MODES) {
        const modeWeights = object(weights[mode], `$.candidates.mode_weights.${mode}`);
        for (const [name, weight] of Object.entries(modeWeights)) {
          nonempty(name, `$.candidates.mode_weights.${mode}`);
          number(weight, `$.candidates.mode_weights.${mode}.${name}`);
        }
      }
      const review = object(record.review, '$.review');
      for (const key of ['batch_size', 'maximum_b_bridges', 'maximum_c_bridges']) {
        integer(review[key], `$.review.${key}`);
      }
      return;
    }
    case 'edge': {
      const record = object(value, '$');
      nonempty(record.from, '$.from');
      nonempty(record.to, '$.to');
      enumValue(record.type, '$.type', ['explicit_link', 'shared_entity', 'same_series']);
      evidence(record.evidence, '$.evidence');
      return;
    }
  }
}
