import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildInteractionCandidates,
  judgementGroups,
  normalizeInteractionReviews,
  rejectInvalidAcceptedReviews,
} from '../dist/interaction-review.js';

const evidence = { revision: 1, section: 'Description', locator: 'Article-specific source evidence.' };

test('maintenance batches existing updates densely but can isolate new subjects', () => {
  const candidates = [
    { subject_page_id: 'scp-001', mode: 'cycle' },
    { subject_page_id: 'scp-002', mode: 'cycle' },
    { subject_page_id: 'scp-001', mode: 'breach' },
  ];
  assert.deepEqual(judgementGroups(candidates, 10, false).map((group) => group.length), [2, 1]);
  assert.deepEqual(judgementGroups(candidates, 10, true).map((group) => group.length), [1, 1, 1]);
});

function semantic(pageId, claimId, direction) {
  return {
    page_id: pageId,
    source_revision: 1,
    schema_version: 2,
    semantic_policy_digest: 'semantic-policy',
    reviewed_modes: ['cycle', 'breach', 'double-feature'],
    coverage: {
      status: 'complete',
      source_digest: `${pageId}-source`,
      analyzed_chunk_ids: ['1/1'],
      unresolved_features: [],
    },
    claims: [{
      id: claimId,
      kind: 'effect',
      domain: 'containment',
      domain_class: 'containment',
      operation: direction,
      operation_class: direction,
      affected_state: 'containment-integrity',
      direction,
      outcomes: ['containment-integrity'],
      preconditions: [],
      limitations: [],
      evidence: [evidence],
      role: 'anomalous-effect',
      chunk_ids: ['1/1'],
    }],
    reading: { themes: [], forms: [], structures: [], tones: [], motifs: [], moves: [] },
  };
}

function candidate(mode, left, right) {
  return {
    review_id: `${mode}:${left.page_id}:${right.page_id}`,
    subject_page_id: left.page_id,
    mode,
    left,
    right,
    left_title: left.page_id,
    right_title: right.page_id,
    retrieval_reasons: [],
  };
}

function acceptedReview(reviewId, proof) {
  return {
    review_id: reviewId,
    verdict: 'accepted',
    mechanism: 'The first article changes a state used by the second.',
    left_claim_refs: ['left-claim'],
    right_claim_refs: ['right-claim'],
    causal_chain: ['first claim', 'second claim'],
    explanation: 'Both article-specific claims are required.',
    assumption: 'The affected state is shared.',
    limitation: '',
    rubric: {
      mode_fit: 'strong',
      coherence: 'conditional',
      specificity: 'article-specific',
      discovery_value: 'medium',
    },
    support: 'B',
    reason: '',
    mode_gate_passed: true,
    mode_gate_reason: 'The mode definition is satisfied.',
    proof,
  };
}

test('breach direction is derived from the unique cross-page proof link', () => {
  const left = semantic('scp-001', 'left-claim', 'increase');
  const right = semantic('scp-002', 'right-claim', 'enable');
  const item = candidate('breach', left, right);
  const review = acceptedReview(item.review_id, {
    mode: 'breach',
    relation: 'activates',
    direction: ['The second acts first.', 'The first is affected.'],
    links: [{
      from_page: right.page_id,
      from_claim: 'right-claim',
      to_page: left.page_id,
      to_claim: 'left-claim',
      relation: 'activates',
    }],
    bridge_assumptions: ['The target remains present.'],
  });

  const [normalized] = normalizeInteractionReviews([item], [review]);

  assert.deepEqual(normalized.proof.direction, [right.page_id, left.page_id]);
});

test('an accepted cycle with unsupported opposite directions is downgraded', () => {
  const left = semantic('scp-001', 'left-claim', 'increase');
  const right = semantic('scp-002', 'right-claim', 'increase');
  const item = candidate('cycle', left, right);
  const review = acceptedReview(item.review_id, {
    mode: 'cycle',
    pattern: 'shared-state-balance',
    links: [{
      from_page: left.page_id,
      from_claim: 'left-claim',
      to_page: right.page_id,
      to_claim: 'right-claim',
      relation: 'opposes',
    }],
    shared_state: 'containment-integrity',
    directions: ['increase', 'decrease'],
    bridge_assumptions: [],
  });
  const dataset = {
    semantics: [left, right],
    semanticOntology: { affected_states: {}, domains: {} },
    analysisPolicy: { review: { maximum_b_bridges: 1, maximum_c_bridges: 2 } },
  };

  const [result] = rejectInvalidAcceptedReviews(
    [item],
    [review],
    new Map(),
    dataset,
  );

  assert.equal(result.verdict, 'rejected');
  assert.equal(result.mode_gate_passed, false);
});

test('a bidirectional amplifying loop is not mutual counteraction', () => {
  const left = semantic('scp-001', 'left-claim', 'disable');
  const right = semantic('scp-002', 'right-claim', 'decrease');
  const item = candidate('cycle', left, right);
  const review = acceptedReview(item.review_id, {
    mode: 'cycle',
    pattern: 'mutual-counteraction',
    links: [{
      from_page: left.page_id,
      from_claim: 'left-claim',
      to_page: right.page_id,
      to_claim: 'right-claim',
      relation: 'amplifies',
    }, {
      from_page: right.page_id,
      from_claim: 'right-claim',
      to_page: left.page_id,
      to_claim: 'left-claim',
      relation: 'amplifies',
    }],
    shared_state: '',
    directions: ['', ''],
    bridge_assumptions: [],
  });
  const dataset = {
    semantics: [left, right],
    semanticOntology: { affected_states: {}, domains: {} },
    analysisPolicy: { review: { maximum_b_bridges: 1, maximum_c_bridges: 2 } },
  };

  const [result] = rejectInvalidAcceptedReviews([item], [review], new Map(), dataset);

  assert.equal(result.verdict, 'rejected');
  assert.equal(result.mode_gate_passed, false);
});

test('a direct limit-renewal loop is proved by typed directions rather than wording', () => {
  const left = semantic('scp-001', 'left-claim', 'transform');
  left.claims[0].operation = 'article-specific transition';
  left.claims[0].outcomes = ['article-specific changed state'];
  left.claims[0].affected_state = 'biological-integrity';
  const right = semantic('scp-002', 'right-claim', 'restore');
  right.claims[0].operation = 'reform after death';
  right.claims[0].outcomes = ['the same actor returns'];
  right.claims[0].affected_state = 'biological-integrity';
  const item = candidate('cycle', left, right);
  const review = acceptedReview(item.review_id, {
    mode: 'cycle',
    pattern: 'shared-state-balance',
    links: [{
      from_page: left.page_id,
      from_claim: 'left-claim',
      to_page: right.page_id,
      to_claim: 'right-claim',
      relation: 'limits the attacker until its restoration renews the interaction',
    }],
    shared_state: 'biological-integrity',
    directions: ['transform', 'restore'],
    bridge_assumptions: ['The restored actor renews the same interaction.'],
  });
  const dataset = {
    semantics: [left, right],
    semanticOntology: { affected_states: {}, domains: {} },
    analysisPolicy: { review: { maximum_b_bridges: 1, maximum_c_bridges: 2 } },
  };

  const [result] = rejectInvalidAcceptedReviews([item], [review], new Map(), dataset);

  assert.equal(result.verdict, 'accepted');
  assert.equal(result.mode_gate_passed, true);
});

test('shared-state proof labels are normalized from their cited claims', () => {
  const left = semantic('scp-001', 'left-claim', 'transform');
  left.claims[0].affected_state = 'biological-integrity';
  const right = semantic('scp-002', 'right-claim', 'restore');
  right.claims[0].affected_state = 'biological-integrity';
  const item = candidate('cycle', left, right);
  const review = acceptedReview(item.review_id, {
    mode: 'cycle',
    pattern: 'shared-state-balance',
    links: [{
      from_page: left.page_id,
      from_claim: 'left-claim',
      to_page: right.page_id,
      to_claim: 'right-claim',
      relation: 'limits the actor before restoration',
    }],
    shared_state: 'the restored actor biological state',
    directions: ['damage through reflection', 'return after death'],
    bridge_assumptions: ['The two actors meet.'],
  });

  const [normalized] = normalizeInteractionReviews([item], [review]);

  assert.equal(normalized.proof.shared_state, 'biological-integrity');
  assert.deepEqual(normalized.proof.directions, ['transform', 'restore']);
});

test('a restoration claim does not form a limit-renewal loop without the directed link', () => {
  const left = semantic('scp-001', 'left-claim', 'transform');
  left.claims[0].affected_state = 'biological-integrity';
  const right = semantic('scp-002', 'right-claim', 'restore');
  right.claims[0].affected_state = 'biological-integrity';
  const item = candidate('cycle', left, right);
  const review = acceptedReview(item.review_id, {
    mode: 'cycle',
    pattern: 'shared-state-balance',
    links: [{
      from_page: right.page_id,
      from_claim: 'right-claim',
      to_page: left.page_id,
      to_claim: 'left-claim',
      relation: 'the restoration is merely adjacent to the transition',
    }],
    shared_state: 'biological-integrity',
    directions: ['transform', 'restore'],
    bridge_assumptions: ['The two actors occupy the same encounter.'],
  });
  const dataset = {
    semantics: [left, right],
    semanticOntology: { affected_states: {}, domains: {} },
    analysisPolicy: { review: { maximum_b_bridges: 1, maximum_c_bridges: 2 } },
  };

  const [result] = rejectInvalidAcceptedReviews([item], [review], new Map(), dataset);

  assert.equal(result.verdict, 'rejected');
  assert.equal(result.mode_gate_passed, false);
});

test('partial coverage does not bypass the configured bridge budget', () => {
  const left = semantic('scp-001', 'left-claim', 'increase');
  const right = semantic('scp-002', 'right-claim', 'decrease');
  left.coverage.status = 'partial';
  left.coverage.unresolved_features = ['unresolved-include'];
  const item = candidate('cycle', left, right);
  const review = acceptedReview(item.review_id, {
    mode: 'cycle',
    pattern: 'shared-state-balance',
    links: [{
      from_page: left.page_id,
      from_claim: 'left-claim',
      to_page: right.page_id,
      to_claim: 'right-claim',
      relation: 'opposes',
    }],
    shared_state: 'containment-integrity',
    directions: ['increase', 'decrease'],
    bridge_assumptions: ['first bridge', 'second bridge', 'third bridge'],
  });
  review.support = 'C';
  review.limitation = 'The first article has partial source coverage.';
  const dataset = {
    semantics: [left, right],
    semanticOntology: { affected_states: {}, domains: {} },
    analysisPolicy: { review: { maximum_b_bridges: 1, maximum_c_bridges: 2 } },
  };

  const [result] = rejectInvalidAcceptedReviews([item], [review], new Map(), dataset);

  assert.equal(result.verdict, 'rejected');
  assert.equal(result.mode_gate_passed, false);
  assert.match(result.verifier_objection, /bridge budget/);
});

test('an existing rejected pair is retained when either semantic profile changes', () => {
  const left = semantic('scp-001', 'left-claim', 'none');
  const right = semantic('scp-002', 'right-claim', 'none');
  const dataset = {
    profiles: [left, right].map((item) => ({ page_id: item.page_id, title: item.page_id })),
    semantics: [left, right],
    interactions: [{
      id: 'cycle-scp-001-scp-002',
      pages: [left.page_id, right.page_id],
      mode: 'cycle',
      source_revisions: { [left.page_id]: 1, [right.page_id]: 1 },
      verdict: 'rejected',
      reason: 'The effects do not counteract one another.',
    }],
    edges: [],
    semanticOntology: { affected_states: {}, domains: {}, operations: {} },
    analysisPolicy: {
      candidates: {
        per_mode_limit: 0,
        mode_weights: { cycle: {}, breach: {}, 'double-feature': {} },
      },
    },
  };

  const candidates = buildInteractionCandidates(
    dataset,
    new Map([[left.page_id, left]]),
    new Map(),
  );

  assert.ok(candidates.some((item) =>
    item.mode === 'cycle' &&
    item.left.page_id === left.page_id && item.right.page_id === right.page_id));
});

test('reading moves alone do not make an arbitrary double-feature candidate', () => {
  const left = semantic('scp-001', 'left-claim', 'none');
  const right = semantic('scp-002', 'right-claim', 'none');
  left.reading.moves = [{
    kind: 'premise',
    description: 'The first article establishes its premise.',
    evidence: [evidence],
    chunk_ids: ['1/1'],
  }];
  right.reading.moves = [{
    kind: 'ending',
    description: 'The second article reaches its ending.',
    evidence: [evidence],
    chunk_ids: ['1/1'],
  }];
  const dataset = {
    profiles: [left, right].map((item) => ({ page_id: item.page_id, title: item.page_id })),
    semantics: [left, right],
    interactions: [],
    edges: [],
    semanticOntology: { affected_states: {}, domains: {}, operations: {} },
    analysisPolicy: {
      candidates: {
        per_mode_limit: 20,
        mode_weights: { cycle: {}, breach: {}, 'double-feature': {} },
      },
    },
  };

  const candidates = buildInteractionCandidates(
    dataset,
    new Map([[left.page_id, left]]),
    new Map(),
  );

  assert.equal(candidates.some((item) => item.mode === 'double-feature'), false);
});

test('a generic increase does not retrieve an unrelated breach candidate', () => {
  const left = semantic('scp-001', 'left-claim', 'increase');
  const right = semantic('scp-002', 'right-claim', 'enable');
  left.claims[0].domain_class = 'biology';
  left.claims[0].affected_state = 'population';
  right.claims[0].domain_class = 'information';
  right.claims[0].affected_state = 'information-state';
  const dataset = {
    profiles: [left, right].map((item) => ({ page_id: item.page_id, title: item.page_id })),
    semantics: [left, right],
    interactions: [],
    edges: [],
    semanticOntology: { affected_states: {}, domains: {}, operations: {} },
    analysisPolicy: {
      candidates: {
        per_mode_limit: 20,
        mode_weights: { cycle: {}, breach: {}, 'double-feature': {} },
      },
    },
  };

  const candidates = buildInteractionCandidates(
    dataset,
    new Map([[left.page_id, left]]),
    new Map(),
  );

  assert.equal(candidates.some((item) => item.mode === 'breach'), false);
});
