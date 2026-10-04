import { interactionSemanticDigest } from './analysis-policy.js';
import type { InteractionCandidate, JudgementReview } from './model-runner.js';
import { normalizeToken } from './profile-compiler.js';
import {
  MODES,
  type Dataset,
  type Mode,
  type ModeProof,
  type PairInteraction,
  type SemanticClaim,
  type SemanticProfile,
} from './types.js';

export function buildInteractionCandidates(
  dataset: Dataset,
  generated: Map<string, SemanticProfile>,
  deferred: Map<string, string>,
  modes: readonly Mode[] = MODES,
): InteractionCandidate[] {
  const allSemantics = new Map(dataset.semantics.map((item) => [item.page_id, item]));
  for (const [pageId, semantic] of generated) allSemantics.set(pageId, semantic);
  const profiles = new Map(dataset.profiles.map((profile) => [profile.page_id, profile]));
  const output: InteractionCandidate[] = [];
  const seen = new Set<string>();
  for (const [pageId, semantic] of [...generated].sort(([left], [right]) => left.localeCompare(right))) {
    if (deferred.has(pageId)) continue;
    for (const mode of modes) {
      const retainedPages = new Set(dataset.interactions
        .filter((interaction) =>
          interaction.mode === mode &&
          interaction.pages.includes(pageId))
        .flatMap((interaction) => interaction.pages.filter((item) => item !== pageId)));
      const ranked = [...allSemantics.values()]
        .filter((candidate) => candidate.page_id !== pageId)
        .map((candidate) => {
          const features = modeCandidateFeatures(mode, semantic, candidate, dataset);
          return {
            semantic: candidate,
            reasons: features,
            score: features.reduce((sum, feature) =>
              sum + (dataset.analysisPolicy.candidates.mode_weights[mode][feature] ?? 1), 0),
            retained: retainedPages.has(candidate.page_id),
          };
        })
        .sort((left, right) =>
          right.score - left.score || left.semantic.page_id.localeCompare(right.semantic.page_id),
        );
      const retained = ranked.filter((candidate) => candidate.retained);
      const discovered = ranked
        .filter((candidate) => !candidate.retained && candidate.score > 0)
        .slice(0, dataset.analysisPolicy.candidates.per_mode_limit);
      for (const { semantic: counterpart, reasons } of [...retained, ...discovered]) {
        const [left, right] = [semantic, counterpart].sort((a, b) =>
          a.page_id.localeCompare(b.page_id),
        );
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
          retrieval_reasons: reasons,
        });
      }
    }
  }
  return output;
}

export function judgementGroups(
  candidates: InteractionCandidate[],
  groupSize = 10,
  isolateSubjects = true,
): InteractionCandidate[][] {
  const byPrimary = new Map<string, InteractionCandidate[]>();
  for (const candidate of candidates) {
    const primary = isolateSubjects
      ? `${candidate.subject_page_id}:${candidate.mode}`
      : candidate.mode;
    const list = byPrimary.get(primary) ?? [];
    list.push(candidate);
    byPrimary.set(primary, list);
  }
  const groups: InteractionCandidate[][] = [];
  for (const list of byPrimary.values()) {
    for (let offset = 0; offset < list.length; offset += groupSize) {
      groups.push(list.slice(offset, offset + groupSize));
    }
  }
  return groups;
}

export function normalizeInteractionReviews(
  candidates: InteractionCandidate[],
  reviews: JudgementReview[],
): JudgementReview[] {
  const candidateById = new Map(candidates.map((candidate) => [
    candidate.review_id,
    candidate,
  ]));
  return reviews.map((review) => {
    if (review.verdict === 'rejected') return review;
    const candidate = candidateById.get(review.review_id);
    if (!candidate) return review;
    const leftClaims = new Set(candidate.left.claims.map((claim) => claim.id));
    const rightClaims = new Set(candidate.right.claims.map((claim) => claim.id));
    const normalizeClaimRef = (claimRef: string): string => {
      for (const [pageId, claims] of [
        [candidate.left.page_id, leftClaims],
        [candidate.right.page_id, rightClaims],
      ] as const) {
        const prefix = `${pageId}:`;
        const unprefixed = claimRef.startsWith(prefix)
          ? claimRef.slice(prefix.length)
          : claimRef;
        if (claims.has(unprefixed)) return unprefixed;
      }
      return claimRef;
    };
    const leftClaimRefs = review.left_claim_refs.map(normalizeClaimRef);
    const rightClaimRefs = review.right_claim_refs.map(normalizeClaimRef);
    const normal =
      leftClaimRefs.every((claim) => leftClaims.has(claim)) &&
      rightClaimRefs.every((claim) => rightClaims.has(claim));
    const swapped =
      leftClaimRefs.length > 0 &&
      rightClaimRefs.length > 0 &&
      leftClaimRefs.every((claim) => rightClaims.has(claim)) &&
      rightClaimRefs.every((claim) => leftClaims.has(claim));
    let normalizedReview = review;
    if (!normal && swapped) {
      normalizedReview = {
        ...review,
        left_claim_refs: rightClaimRefs,
        right_claim_refs: leftClaimRefs,
      };
    } else if (normal) {
      normalizedReview = {
        ...review,
        left_claim_refs: leftClaimRefs,
        right_claim_refs: rightClaimRefs,
      };
    }
    if (normalizedReview.proof?.mode === 'cycle' &&
      normalizedReview.proof.pattern === 'mutual-counteraction') {
      const {
        shared_state: _sharedState,
        directions: _directions,
        ...proof
      } = normalizedReview.proof;
      normalizedReview = { ...normalizedReview, proof };
    }
    if (normalizedReview.proof?.mode === 'cycle' &&
      normalizedReview.proof.pattern === 'shared-state-balance') {
      const referencedByPage = new Map([
        [candidate.left.page_id, new Set<string>()],
        [candidate.right.page_id, new Set<string>()],
      ]);
      for (const link of normalizedReview.proof.links) {
        referencedByPage.get(link.from_page)?.add(link.from_claim);
        referencedByPage.get(link.to_page)?.add(link.to_claim);
      }
      const statesByPage = [candidate.left, candidate.right].map((semantic) =>
        new Set(semantic.claims
          .filter((claim) =>
            referencedByPage.get(semantic.page_id)?.has(claim.id) &&
            claim.affected_state !== 'other')
          .map((claim) => claim.affected_state)),
      );
      const sharedStates = [...statesByPage[0]!].filter((state) => statesByPage[1]!.has(state));
      if (sharedStates.length === 1) {
        const sharedState = sharedStates[0]!;
        const directions = [candidate.left, candidate.right].map((semantic) =>
          [...new Set(semantic.claims
            .filter((claim) =>
              referencedByPage.get(semantic.page_id)?.has(claim.id) &&
              claim.affected_state === sharedState)
            .map(claimDirection))],
        );
        if (directions.every((values) => values.length === 1)) {
          normalizedReview = {
            ...normalizedReview,
            proof: {
              ...normalizedReview.proof,
              shared_state: sharedState,
              directions: [directions[0]![0]!, directions[1]![0]!],
            },
          };
        }
      }
    }
    if (normalizedReview.proof?.mode !== 'breach') return normalizedReview;
    const pageIds = new Set([candidate.left.page_id, candidate.right.page_id]);
    const crossDirections = [...new Set(normalizedReview.proof.links
      .filter((link) =>
        link.from_page !== link.to_page &&
        pageIds.has(link.from_page) &&
        pageIds.has(link.to_page))
      .map((link) => `${link.from_page}:${link.to_page}`))];
    if (crossDirections.length !== 1) return normalizedReview;
    const [fromPage, toPage] = crossDirections[0]!.split(':') as [string, string];
    return {
      ...normalizedReview,
      proof: { ...normalizedReview.proof, direction: [fromPage, toPage] },
    };
  });
}

export function rejectInvalidAcceptedReviews(
  candidates: InteractionCandidate[],
  reviews: JudgementReview[],
  generated: Map<string, SemanticProfile>,
  dataset: Dataset,
): JudgementReview[] {
  const candidatesById = new Map(candidates.map((candidate) => [candidate.review_id, candidate]));
  return reviews.map((review) => {
    if (review.verdict === 'rejected') return review;
    const candidate = candidatesById.get(review.review_id);
    if (!candidate) return review;
    try {
      validateReviews([candidate], [review], generated, dataset);
      return review;
    } catch (error) {
      return {
        review_id: review.review_id,
        verdict: 'rejected',
        mechanism: '',
        left_claim_refs: [],
        right_claim_refs: [],
        causal_chain: [],
        explanation: '',
        assumption: '',
        limitation: '',
        rubric: {
          mode_fit: 'partial',
          coherence: 'thematic',
          specificity: 'generic',
          discovery_value: 'low',
        },
        support: 'C',
        reason: 'The structured review did not satisfy the mode requirements.',
        mode_gate_passed: false,
        mode_gate_reason: 'The deterministic proof check failed.',
        verifier_objection: errorMessage(error),
      };
    }
  });
}

export function validateReviews(
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
    if (typeof review.mode_gate_passed !== 'boolean' || !review.mode_gate_reason.trim()) {
      throw new Error(`Interaction review has no mode gate decision: ${review.review_id}`);
    }
    if (review.verdict === 'rejected') {
      if (!review.reason.trim()) throw new Error(`Rejected review has no reason: ${review.review_id}`);
      continue;
    }
    if (!review.mode_gate_passed || !review.mode_gate_reason.trim()) {
      throw new Error(`Accepted review did not pass the mode gate: ${review.review_id}`);
    }
    if (!review.proof) {
      throw new Error(`Accepted review has no typed proof: ${review.review_id}`);
    }
    validateModeProof(review.proof, {
      id: candidate.review_id,
      mode: candidate.mode,
      pages: [candidate.left.page_id, candidate.right.page_id],
    }, semantics);
    supportFromProof(review.proof, candidate, dataset);
    const partialCoverage = [candidate.left, candidate.right]
      .some((semantic) => semantic.coverage.status === 'partial');
    if (partialCoverage && candidate.mode === 'double-feature') {
      throw new Error(`Double-feature review has partial source coverage: ${review.review_id}`);
    }
    if (partialCoverage && (review.support !== 'C' || !review.limitation.trim())) {
      throw new Error(`Partial-coverage review must be support C with a limitation: ${review.review_id}`);
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

export function reviewsToInteractions(
  candidates: InteractionCandidate[],
  reviews: JudgementReview[],
  dataset: Dataset,
  policyDigests: { candidate: string; review_modes: Record<Mode, string> },
): PairInteraction[] {
  const candidateById = new Map(candidates.map((candidate) => [candidate.review_id, candidate]));
  return reviews.map((review) => {
    const candidate = candidateById.get(review.review_id)!;
    const pages: [string, string] = [candidate.left.page_id, candidate.right.page_id];
    const sourceRevisions = {
      [pages[0]]: candidate.left.source_revision,
      [pages[1]]: candidate.right.source_revision,
    };
    const provenance = {
      semantic_digests: {
        [pages[0]]: interactionSemanticDigest(candidate.left),
        [pages[1]]: interactionSemanticDigest(candidate.right),
      },
      candidate_policy_digest: policyDigests.candidate,
      review_policy_digest: policyDigests.review_modes[candidate.mode],
    };
    const id = `auto-${candidate.mode}-${pages[0]}-${pages[1]}`;
    if (review.verdict === 'rejected' || !review.mode_gate_passed) {
      return {
        id,
        pages,
        mode: candidate.mode,
        source_revisions: sourceRevisions,
        ...provenance,
        verdict: 'rejected',
        reason: review.verdict === 'rejected' ? review.reason : review.mode_gate_reason,
      };
    }
    const proof = review.proof!;
    const proofSupport = supportFromProof(proof, candidate, dataset);
    const support = weakerSupport(review.support, proofSupport);
    return {
      id,
      pages,
      mode: candidate.mode,
      source_revisions: sourceRevisions,
      ...provenance,
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
      support,
      proof,
    };
  });
}

export function compareInteractionQuality(left: PairInteraction, right: PairInteraction): number {
  return interactionQuality(right) - interactionQuality(left) || left.id.localeCompare(right.id);
}

export function validateModeProof(
  proof: ModeProof,
  subject: { id: string; mode: Mode; pages: [string, string] },
  semantics: Map<string, SemanticProfile>,
): void {
  if (proof.mode !== subject.mode) throw new Error(`Proof mode mismatch: ${subject.id}`);
  const pages = new Set(subject.pages);
  const validClaimLink = (link: {
    from_page: string; from_claim: string; to_page: string; to_claim: string;
  }) =>
    pages.has(link.from_page) && pages.has(link.to_page) &&
    semantics.get(link.from_page)?.claims.some((claim) => claim.id === link.from_claim) &&
    semantics.get(link.to_page)?.claims.some((claim) => claim.id === link.to_claim);
  if (proof.mode === 'cycle') {
    if (proof.links.some((link) => !validClaimLink(link))) {
      throw new Error(`Cycle proof has invalid links: ${subject.id}`);
    }
    if (proof.pattern === 'mutual-counteraction') {
      const [left, right] = subject.pages;
      const hasCounteraction = (fromPage: string, toPage: string) => proof.links.some((link) => {
        if (link.from_page !== fromPage || link.to_page !== toPage) return false;
        const sourceClaim = semantics.get(fromPage)?.claims.find((claim) =>
          claim.id === link.from_claim);
        return sourceClaim !== undefined &&
          isCounteractingClaim(sourceClaim) &&
          isCounteractingRelation(link.relation);
      });
      const hasForward = hasCounteraction(left, right);
      const hasReverse = hasCounteraction(right, left);
      if (!hasForward || !hasReverse) {
        throw new Error(`Cycle proof is not mutual counteraction: ${subject.id}`);
      }
    } else {
      const sharedState = normalizeToken(proof.shared_state ?? '');
      const directions = proof.directions;
      const hasCrossPageLink = proof.links.some((link) => link.from_page !== link.to_page);
      const claimRefs = new Map<string, Set<string>>([
        [subject.pages[0], new Set<string>()],
        [subject.pages[1], new Set<string>()],
      ]);
      for (const link of proof.links) {
        claimRefs.get(link.from_page)?.add(link.from_claim);
        claimRefs.get(link.to_page)?.add(link.to_claim);
      }
      const cyclePages = subject.pages.map((pageId) => semantics.get(pageId));
      const supportedDirections = directions && cyclePages.every((semantic, index) =>
        semantic?.claims.some((claim) =>
          claimRefs.get(semantic.page_id)?.has(claim.id) &&
          normalizeToken(claim.affected_state) === sharedState &&
          claimDirection(claim) === directions[index]),
      );
      const renewalIndex = directions?.findIndex((direction) => direction === 'restore') ?? -1;
      const limitingIndex = renewalIndex < 0 ? -1 : 1 - renewalIndex;
      const limitingDirections = new Set(['decrease', 'disable', 'transform']);
      const limitingPage = limitingIndex < 0 ? undefined : subject.pages[limitingIndex];
      const renewedPage = renewalIndex < 0 ? undefined : subject.pages[renewalIndex];
      const limitRenewal = directions &&
        limitingIndex >= 0 &&
        limitingDirections.has(directions[limitingIndex]!) &&
        proof.links.some((link) =>
          link.from_page === limitingPage && link.to_page === renewedPage &&
          claimDirection(semantics.get(link.from_page)?.claims.find((claim) =>
            claim.id === link.from_claim)!) === directions[limitingIndex] &&
          claimDirection(semantics.get(link.to_page)?.claims.find((claim) =>
            claim.id === link.to_claim)!) === 'restore');
      if (
        !sharedState ||
        !directions ||
        !hasCrossPageLink ||
        !supportedDirections ||
        (!oppositeDirections(directions[0], directions[1]) && !limitRenewal)
      ) {
        throw new Error(`Cycle balance proof has no opposite state change: ${subject.id}`);
      }
    }
  } else if (proof.mode === 'breach') {
    if (!pages.has(proof.direction[0]) || !pages.has(proof.direction[1]) || proof.direction[0] === proof.direction[1]) {
      throw new Error(`Breach proof direction is invalid: ${subject.id}`);
    }
    if (
      proof.links.some((link) => !validClaimLink(link)) ||
      !proof.links.some((link) =>
        link.from_page === proof.direction[0] && link.to_page === proof.direction[1])
    ) {
      throw new Error(`Breach proof has no valid directed link: ${subject.id}`);
    }
  } else {
    for (const pageId of pages) {
      const refs = proof.anchors.find((anchor) => anchor.page_id === pageId)?.claim_refs ?? [];
      if (refs.length === 0 || refs.some((ref) =>
        !semantics.get(pageId)?.claims.some((claim) => claim.id === ref))) {
        throw new Error(`Double-feature proof has invalid anchors: ${subject.id}/${pageId}`);
      }
      const semantic = semantics.get(pageId);
      if (semantic?.coverage.status !== 'complete') {
        throw new Error(`Double-feature proof requires complete source coverage: ${subject.id}/${pageId}`);
      }
    }
    if (!proof.ordering_gain.trim() || !proof.replacement_test.trim()) {
      throw new Error(`Double-feature proof is not replacement-resistant: ${subject.id}`);
    }
  }
}

function isCounteractingClaim(claim: SemanticClaim): boolean {
  return claim.role === 'countermeasure' ||
    ['suppress', 'disable', 'restore'].includes(claim.operation_class) ||
    ['decrease', 'disable', 'restore'].includes(claimDirection(claim));
}

function isCounteractingRelation(relation: string): boolean {
  const normalized = normalizeToken(relation);
  return [
    'counteract', 'constrain', 'limit', 'neutraliz', 'oppos', 'restor', 'stabiliz', 'suppress',
  ].some((term) => normalized.includes(term));
}

function supportFromProof(
  proof: NonNullable<JudgementReview['proof']>,
  candidate: InteractionCandidate,
  dataset: Dataset,
): 'A' | 'B' | 'C' {
  const bridges = proof.bridge_assumptions.length;
  const partialCoverage = [candidate.left, candidate.right]
    .some((semantic) => semantic.coverage.status === 'partial');
  if (bridges > dataset.analysisPolicy.review.maximum_c_bridges) {
    throw new Error(`Interaction proof exceeds the supported bridge budget: ${candidate.review_id}`);
  }
  if (partialCoverage) return 'C';
  if (bridges === 0) return 'A';
  if (bridges <= dataset.analysisPolicy.review.maximum_b_bridges) return 'B';
  return 'C';
}

function weakerSupport(left: 'A' | 'B' | 'C', right: 'A' | 'B' | 'C'): 'A' | 'B' | 'C' {
  const rank = { A: 3, B: 2, C: 1 } as const;
  return rank[left] <= rank[right] ? left : right;
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

function modeCandidateFeatures(
  mode: Mode,
  left: SemanticProfile,
  right: SemanticProfile,
  dataset: Dataset,
): string[] {
  const features = new Set<string>();
  const explicit = dataset.edges.some((edge) =>
    (edge.from === left.page_id && edge.to === right.page_id) ||
    (edge.from === right.page_id && edge.to === left.page_id));
  if (explicit) features.add('explicit-link');
  if (mode === 'cycle') {
    for (const leftClaim of left.claims) {
      for (const rightClaim of right.claims) {
        const leftState = claimState(leftClaim);
        const rightState = claimState(rightClaim);
        if (leftState !== 'other' && leftState === rightState &&
          oppositeDirections(claimDirection(leftClaim), claimDirection(rightClaim))) {
          features.add('opposite-state');
        }
        if (
          compatibleClaimContext(leftClaim, rightClaim) &&
          [leftClaim.role, rightClaim.role].includes('countermeasure') &&
          [leftClaim.role, rightClaim.role].some((role) =>
            role === 'anomalous-effect' || role === 'propagation')
        ) features.add('countermeasure-threat');
        if (
          [leftClaim.role, rightClaim.role].includes('containment-dependency') &&
          [claimDirection(leftClaim), claimDirection(rightClaim)].includes('restore') &&
          sharedAffectedState(leftClaim, rightClaim)
        ) features.add('dependency-restoration');
      }
    }
  } else if (mode === 'breach') {
    for (const [source, target] of [[left, right], [right, left]] as const) {
      for (const sourceClaim of source.claims) {
        for (const targetClaim of target.claims) {
          if (normalizedOverlap(sourceClaim.outcomes, targetClaim.preconditions)) {
            features.add('outcome-trigger');
          }
          if (
            targetClaim.role === 'containment-dependency' &&
            ['disable', 'decrease'].includes(claimDirection(sourceClaim)) &&
            claimState(sourceClaim) === claimState(targetClaim)
          ) features.add('dependency-disable');
          if (
            (sourceClaim.role === 'propagation' ||
              ['propagate', 'replicate', 'transmit', 'infect'].some((value) =>
                sourceClaim.operation.toLowerCase().includes(value))) &&
            canonicalClaimDomain(sourceClaim) === canonicalClaimDomain(targetClaim)
          ) features.add('propagation');
          if (
            ['increase', 'enable'].includes(claimDirection(sourceClaim)) &&
            ['failure-trigger', 'propagation', 'anomalous-effect'].includes(targetClaim.role) &&
            compatibleClaimContext(sourceClaim, targetClaim)
          ) features.add('amplification');
        }
      }
    }
  } else {
    const leftReading = left.reading;
    const rightReading = right.reading;
    if (readingOverlap(leftReading?.themes ?? [], rightReading?.themes ?? [])) {
      features.add('theme-dialogue');
    }
    if (
      readingOverlap(leftReading?.forms ?? [], rightReading?.forms ?? []) ||
      readingOverlap(leftReading?.structures ?? [], rightReading?.structures ?? [])
    ) features.add('structure-contrast');
    if (readingOverlap(leftReading?.motifs ?? [], rightReading?.motifs ?? [])) {
      features.add('motif');
    }
  }
  return [...features].sort();
}

function canonicalClaimDomain(claim: SemanticClaim): string {
  return claim.domain_class;
}

function claimState(claim: SemanticClaim): string {
  return claim.affected_state;
}

function claimDirection(claim: SemanticClaim): string {
  return claim.direction;
}

function oppositeDirections(left: string, right: string): boolean {
  return new Set([
    'increase:decrease', 'decrease:increase',
    'enable:disable', 'disable:enable',
    'decrease:restore', 'restore:decrease',
  ]).has(`${left}:${right}`);
}

function sharedAffectedState(left: SemanticClaim, right: SemanticClaim): boolean {
  return claimState(left) !== 'other' && claimState(left) === claimState(right);
}

function compatibleClaimContext(left: SemanticClaim, right: SemanticClaim): boolean {
  return sharedAffectedState(left, right) || (
    canonicalClaimDomain(left) !== 'other' &&
    canonicalClaimDomain(left) === canonicalClaimDomain(right)
  );
}

function normalizedOverlap(left: string[], right: string[]): boolean {
  const rightValues = new Set(right.map((value) => value.trim().toLowerCase()));
  return left.some((value) => rightValues.has(value.trim().toLowerCase()));
}

function readingOverlap(left: string[], right: string[]): boolean {
  const rightValues = new Set(right.map(normalizeToken));
  return left.some((value) => rightValues.has(normalizeToken(value)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
