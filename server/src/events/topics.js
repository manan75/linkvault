/**
 * The event log's topics.
 *
 * `CLAUDE.md` names five events and all five now exist, each with a producer.
 * The rule that kept `embedding.created` out until Phase 6 still stands: a
 * topic nothing writes to is a place for a subscriber to wait forever.
 *
 * Note on the names: Kafka warns that topics mixing `.` and `_` can collide in
 * metric names. Everything here uses `.` and nothing uses `_`, so there is
 * nothing to collide with -- but a future topic must not be named `link_created`.
 */
export const TOPICS = {
  /** A bookmark exists and has never been processed. Consumed by the metadata worker. */
  LINK_CREATED: 'link.created',
  /** Extraction finished. Consumed by the enrichment worker. */
  METADATA_EXTRACTED: 'metadata.extracted',
  /**
   * A summary and auto-tags were written. Consumed by the embedding worker,
   * which is what this event was published into an empty topic for: the seam
   * held, and Phase 6 attached a consumer without touching Phase 5's producer.
   */
  LINK_ENRICHED: 'link.enriched',
  /**
   * A link has a vector and is now findable by description. Nothing consumes
   * this -- it is the end of the pipeline. Published anyway, on the same
   * reasoning that left `link.enriched` unconsumed for a phase: a stage that
   * announces its result can be built on without being reopened, and a
   * "reindex my vault" or an activity feed would both start here.
   */
  EMBEDDING_CREATED: 'embedding.created',
  /** A stage gave up on a link. Observability only -- retries live in the document. */
  PROCESSING_FAILED: 'link.processing.failed',
};

/**
 * Three partitions so a consumer group can scale to three members without a
 * repartition, which would break the per-key ordering guarantee mid-flight.
 * Replication is 1 because development runs a single broker; production
 * replication is a Phase 9 decision.
 */
export const TOPIC_DEFINITIONS = Object.values(TOPICS).map((topic) => ({
  topic,
  numPartitions: 3,
  replicationFactor: 1,
}));
