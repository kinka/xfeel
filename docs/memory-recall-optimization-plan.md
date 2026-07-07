# Memory Extraction & Recall Optimization Plan

Date: 2026-06-15

## Goal

Improve xfeel-v3 memory quality and retrieval by separating stable structure, open facts, lexical recall, embedding recall, and reranking.

The target is not to make a bigger tag vocabulary. The target is a hybrid memory system where:

- structured fields prevent wrong answers and owner leaks;
- open facts preserve long-tail diary details;
- lexical recall catches exact evidence;
- embeddings recover semantic near-misses;
- reranking and thresholds decide final answerability.

## Current baseline

Recall quality is tracked with the sanitized eval fixtures under `data/eval/`.
The current direction is hybrid recall: lexical/structured candidates remain mandatory, while embeddings are used as an additional candidate source with owner hard filters and no-answer gates.

## North-star architecture

```text
raw message
  -> episode segmentation
  -> atomic event extraction
  -> stable fields
  -> open facts with evidence spans
  -> lexical index
  -> embedding index

query
  -> intent + owner/time constraints
  -> lexical candidate recall
  -> embedding candidate recall
  -> candidate union/dedup
  -> structure-aware reranker
  -> no-answer / confidence gate
  -> answer with cited evidence
```

## Layer 1: Stable structured fields

Keep a small set of hard/stable fields. These should not become long-tail vocabularies.

Required stable fields:

- `owner_id`: hard filter; never semantic.
- `event_date` / `event_time`: hard range/filter/sort.
- `episode_id` / `raw_message_id`: provenance and regrouping.
- `frame`: coarse domain such as `body_health`, `sleep_routine`, `feeding`, `activity`, `travel`, `work_life`, `inner_world`, `relationship`, `development`.
- `participants`: typed roles, not just entity list.
- `salience`: importance/long-term value.
- `polarity/status`: actual vs negated vs hypothetical vs concern.

Principle:

```text
Stable structure is for correctness and filtering, not semantic richness.
```

## Layer 2: Open facts

Replace overloaded `tags` with typed open facts.

Proposed shape:

```ts
type OpenFact = {
  id: string;
  event_id: string;
  kind:
    | "symptom"
    | "food"
    | "activity"
    | "object"
    | "place"
    | "routine"
    | "work_topic"
    | "emotion_signal"
    | "developmental_skill"
    | "relationship_signal"
    | "topic";
  value: string;        // canonical but open, e.g. "呕吐"
  surface: string;      // original phrase, e.g. "吐了好几次"
  evidence_span?: [number, number];
  confidence?: number;
  polarity?: "actual" | "negated" | "hypothetical" | "concern";
  actor_id?: string;
  experiencer_id?: string;
  observer_id?: string;
};
```

Important:

- `kind` can be semi-stable.
- `value` must remain open.
- every fact should trace back to original text.
- extraction should not inject excessive synonyms for recall.

## Layer 3: Episode + atomic event split

Current long paragraphs are often compressed into one `event_type` and several tags. That causes both miss and false match.

New extraction should produce:

```text
raw_message
  -> episode: one diary paragraph / coherent scene
      -> atomic_event 1: child vomited after ice cream
      -> atomic_event 2: parent worried about illness
      -> atomic_event 3: evening sleep affected
```

Keep both:

- atomic events for precise retrieval;
- episode for narrative answer and context.

## Layer 4: Lexical recall remains mandatory

Do not replace current FTS/BM25-style recall.

Lexical is still best for:

- exact names and places;
- rare strings;
- numeric/date details;
- original evidence snippets;
- low-latency candidate retrieval.

Maintain deterministic query expansion, but keep it conservative:

- common aliases okay: `上吐下泻 -> 呕吐/腹泻`;
- avoid corpus-specific aliases that encode one case too directly;
- expansion should be evaluated by precision and recall fixtures.

## Layer 5: Embedding recall as candidate generator

Use a local or OpenAI-compatible embedding provider for long-tail semantic recall.

Embed these units:

1. event semantic text;
2. each open fact;
3. episode summary;
4. optionally answer-oriented summaries.

Recommended embedding text template:

```text
kind: symptom
value: 呕吐
surface: 吐了好几次
frame: body_health
participants: 星星 experiencer, 爸爸 observer
summary: 星星吃了冰激凌后吐了好几次，爸爸担心
span: ...
```

Rules:

- owner/time filters happen before or during vector candidate retrieval;
- embedding is not allowed to override owner;
- embedding candidates are merged with lexical candidates;
- keep `embedding_model` and `embedding_dim` versioned.

## Layer 6: Structure-aware reranking

Hybrid candidate generation is not enough. Need a reranker that improves top-5 quality.

Suggested score components:

```text
final_score =
  lexical_score
  + embedding_score
  + frame_match_boost
  + fact_kind_match_boost
  + participant_role_boost
  + recency_or_temporal_fit
  + exact_evidence_boost
  - wrong_frame_penalty
  - generic_parent_penalty
  - negation_or_hypothetical_penalty
```

The reranker should explain scores for eval/debugging.

## Layer 7: No-answer and precision gates

Recall improvement must not become hallucinated answering.

Add no-answer gates:

- minimum final score;
- minimum evidence coverage;
- no semantic-only answer for sensitive factual queries unless supported by exact/open-fact evidence;
- wrong-owner and no-owner leakage checks;
- negative query fixtures.

Precision eval should include:

- wrong owner similar event;
- broad query with no actual memory;
- negated facts;
- hypothetical/concern-only facts;
- generic parent-life query that should not match child-specific detail too strongly.

## Data/storage plan

Short term:

- keep the `memory_embeddings` sidecar table;
- store vectors as Float32 BLOB with JSON fallback for old rows;
- keep build/eval scripts separate from runtime.

Medium term:

- add formal migrations for:
  - `memory_facts`
  - `memory_episodes`
  - `memory_embeddings`
- move vector scan to sqlite-vec or a local vector index;
- incremental embedding refresh by `source_updated_at` / hash.

Suggested production-ish tables:

```sql
memory_episodes(
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  raw_message_id TEXT,
  event_date TEXT,
  title TEXT,
  summary TEXT,
  evidence_text TEXT,
  created_at TEXT,
  updated_at TEXT
);

memory_facts(
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  episode_id TEXT,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  surface TEXT NOT NULL,
  evidence_start INTEGER,
  evidence_end INTEGER,
  actor_id TEXT,
  experiencer_id TEXT,
  observer_id TEXT,
  polarity TEXT DEFAULT 'actual',
  confidence REAL,
  created_at TEXT,
  updated_at TEXT
);

memory_embeddings(
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  fact_kind TEXT,
  embedding_model TEXT NOT NULL,
  embedding_dim INTEGER NOT NULL,
  embedding_text TEXT NOT NULL,
  embedding_blob BLOB,
  embedding_json TEXT,
  source_hash TEXT,
  source_updated_at TEXT,
  created_at TEXT,
  updated_at TEXT
);
```

## Implementation roadmap

### Phase 0: Lock metrics and guardrails

- Keep current recall eval as baseline.
- Add embedding/hybrid precision eval.
- Add regression cases for known miss/regress examples.
- Define target thresholds:
  - owner leak: 0
  - Hit@10: does not regress from current hybrid recall
  - Hit@5: improve over baseline
  - no-answer false positive rate: explicitly tracked

### Phase 1: Harden embedding recall

- Add tests for `embedding-common.ts`.
- Make build script incremental.
- Add `--owner`, `--since`, `--event-id` filters for partial rebuild.
- Add precision eval script for embedding/hybrid.
- Add threshold sweep script to find recall/precision tradeoff.

### Phase 2: Runtime hybrid candidate recall

- Add a retrieval API that returns candidate events from both lexical and embedding recall.
- Keep old lexical recall available behind a flag.
- Add score explanations.
- Use owner/time as hard filters.
- Use embedding only as candidate generation, not final truth.

### Phase 3: Open facts extraction v2

- Extend extractor output with typed open facts.
- Keep old `tags/entities` populated for compatibility.
- Store open facts with evidence spans.
- Add tests on known cases:
  - ice cream -> vomiting symptom and food fact;
  - magnetic tiles -> object/activity fact;
  - Haimen/waves -> place/activity fact;
  - performance/client receipts -> work_topic fact;
  - after-school excitement -> routine/activity/emotion fact.

### Phase 4: Reranker

- Implement deterministic structure-aware reranker first.
- Add score breakdown to eval output.
- Tune against recall + precision fixtures.
- Optional later: LLM reranker only for close ties, never for owner filtering.

### Phase 5: Vector index optimization

- Replace JSON full scan with sqlite-vec or a local vector index.
- Preserve sidecar schema and metadata.
- Keep compatibility script to rebuild embeddings.
- Target query p95 below 150–250ms if possible.

### Phase 6: Reprocess old data

- Run extractor v2 on existing corpus.
- Preserve raw-message provenance and stable IDs where possible.
- Compare before/after recall and precision.
- Audit top regressions manually before making default.

## Acceptance criteria

A version is ready to turn on by default when:

1. owner leak remains 0 across recall and precision fixtures;
2. hybrid Hit@10 >= 98% on real recall set;
3. Hit@5 improves over lexical baseline;
4. no-answer precision is measured and acceptable;
5. latency is acceptable or feature-gated;
6. every answer can cite original evidence text;
7. extractor changes do not destroy existing `tags/entities` compatibility until migration is complete.

## Key principle

```text
Structured fields prevent wrong answers.
Open facts preserve real detail.
Embeddings prevent semantic misses.
Reranking decides what is actually relevant.
Evidence spans keep the system honest.
```
