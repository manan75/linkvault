/**
 * The event log's topics.
 *
 * `CLAUDE.md` names five events. Only the ones something actually produces or
 * consumes are created -- a topic nothing reads is a place for messages to
 * accumulate unnoticed. `embedding.created` (Phase 6) is deliberately absent
 * until it has a producer; `link.enriched` gained one in Phase 5.
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
   * A summary and auto-tags were written. Nothing consumes this yet -- Phase 6
   * subscribes to it to generate the embedding, which is exactly why the
   * enrichment worker publishes it now rather than later: the event is the
   * seam, and adding a consumer later must not require touching this worker.
   */
  LINK_ENRICHED: 'link.enriched',
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
