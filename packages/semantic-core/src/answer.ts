import type {
  AnswerEvidence,
  Confidence,
  Decision,
  SefiAnswer,
  SemanticFact,
  SourceRecord,
} from "@sefi/shared-types";

const CONF_RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

/** The overall answer confidence is the weakest fact it relies on (spec §21). */
export function aggregateConfidence(facts: SemanticFact[]): Confidence {
  if (facts.length === 0) return "low";
  let worst: Confidence = "high";
  for (const f of facts) {
    if (CONF_RANK[f.confidence] < CONF_RANK[worst]) worst = f.confidence;
  }
  return worst;
}

export interface AssembleAnswerInput {
  text: string;
  decision?: Decision;
  recommendedActions?: string[];
  facts: SemanticFact[];
  sourceRecords: SourceRecord[];
  evidence?: AnswerEvidence[];
  warnings?: string[];
  contextCapsuleId?: string;
}

/**
 * Assemble the grounded {@link SefiAnswer} envelope (spec §13.5 / §14.5). Trims
 * source records to the proof-relevant projection and derives evidence from the
 * facts when not supplied explicitly.
 */
export function assembleAnswer(input: AssembleAnswerInput): SefiAnswer {
  const evidence: AnswerEvidence[] =
    input.evidence ??
    input.facts.map((f) => ({
      fact: f.field,
      value: f.value,
      sourceRecordId: f.sourceRecordIds[0],
    }));
  return {
    text: input.text,
    confidence: aggregateConfidence(input.facts),
    decision: input.decision,
    recommendedActions: input.recommendedActions ?? [],
    facts: input.facts,
    sourceRecords: input.sourceRecords.map((s) => ({
      id: s.id,
      protocol: s.protocol,
      ledgerSeq: s.ledgerSeq,
      responseHash: s.responseHash,
    })),
    evidence,
    contextCapsuleId: input.contextCapsuleId,
    warnings: input.warnings ?? [],
  };
}

/** Lookup helper used by adapter ask() implementations. */
export function factValue(
  facts: SemanticFact[],
  field: string,
  entityId?: string,
): unknown {
  const f = facts.find(
    (x) => x.field === field && (!entityId || x.entityId === entityId),
  );
  return f?.value;
}
