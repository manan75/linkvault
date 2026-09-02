import { Kafka, logLevel } from 'kafkajs';

import { withDeadline } from '../utils/withDeadline.js';
import { TOPIC_DEFINITIONS } from './topics.js';

/**
 * Every call into kafkajs is bounded, because kafkajs does not bound itself:
 * with the broker unreachable it retries the seed broker forever and neither
 * `connect()` nor `send()` ever settles. An unbounded await at startup means
 * the API never begins listening; one inside the reaper's loop stalls the
 * pipeline until the process is restarted.
 */
const CONNECT_TIMEOUT_MS = 8_000;

/**
 * The Kafka-backed event bus.
 *
 * `kafkajs` rather than a librdkafka binding: it is pure JavaScript, so there
 * is no native build step. That matters on this project specifically -- the
 * development machine is Windows, where native module builds are the single
 * most reliable way to lose an afternoon.
 */
export function createKafkaBus({ brokers, clientId, logger = console }) {
  const kafka = new Kafka({
    clientId,
    brokers,
    logLevel: logLevel.ERROR,
    connectionTimeout: 3_000,
    requestTimeout: 8_000,
    // Short: the reaper retries on its own schedule with its own backoff, so a
    // long retry ladder in here only delays the failure being noticed.
    retry: { initialRetryTime: 200, retries: 3 },
  });

  const producer = kafka.producer({ allowAutoTopicCreation: false });
  const consumers = [];
  let isStarted = false;
  let starting = null;

  async function connect() {
    const admin = kafka.admin();
    await withDeadline(admin.connect(), CONNECT_TIMEOUT_MS, 'Kafka did not respond');

    try {
      // Only create what is missing. Calling createTopics unconditionally makes
      // every process after the first log a broker-side error for topics that
      // already exist -- noise at startup that trains you to ignore startup logs.
      const existing = new Set(await admin.listTopics());
      const missing = TOPIC_DEFINITIONS.filter(({ topic }) => !existing.has(topic));

      if (missing.length > 0) {
        try {
          await admin.createTopics({ topics: missing, waitForLeaders: true });
        } catch (error) {
          // Two processes starting together can both see a topic as missing.
          // Losing that race is fine as long as the topic now exists.
          const after = new Set(await admin.listTopics());
          if (missing.some(({ topic }) => !after.has(topic))) throw error;
        }
      }
    } finally {
      await admin.disconnect();
    }

    await withDeadline(producer.connect(), CONNECT_TIMEOUT_MS, 'Kafka did not respond');
    isStarted = true;
  }

  /**
   * Connects if it is not already, and only once at a time.
   *
   * Every entry point goes through this rather than trusting a connection made
   * at boot. A kafkajs producer that has never connected -- or that was
   * disconnected by an outage -- does not reconnect itself; `send` just keeps
   * failing with "The producer is disconnected". Started once at boot, an API
   * that happened to come up while the broker was down could never publish
   * again for the life of the process, and nothing would say so beyond a
   * repeating log line.
   */
  async function ensureStarted() {
    if (isStarted) return;

    // Concurrent publishes must not each open their own connection.
    starting ??= connect().finally(() => {
      starting = null;
    });

    await starting;
  }

  return {
    start: ensureStarted,

    async stop() {
      await Promise.allSettled([
        producer.disconnect(),
        ...consumers.map((consumer) => consumer.disconnect()),
      ]);
      consumers.length = 0;
      isStarted = false;
    },

    /**
     * `key` is the link id, so every event about one bookmark lands on the same
     * partition and is delivered in order. Keying by user would serialise a
     * whole account behind its slowest link.
     */
    async publish(topic, key, payload) {
      await ensureStarted();

      try {
        await producer.send({
          topic,
          messages: [{ key: String(key), value: JSON.stringify(payload) }],
        });
      } catch (error) {
        // The connection may be the casualty rather than this message. Marking
        // it dead means the next publish reconnects instead of failing forever;
        // the reaper's cooldown is what stops that becoming a hot loop.
        isStarted = false;
        throw error;
      }
    },

    async subscribe({ topic, groupId, handler }) {
      await ensureStarted();

      const consumer = kafka.consumer({ groupId });
      consumers.push(consumer);

      await consumer.connect();
      await consumer.subscribe({ topic, fromBeginning: true });

      await consumer.run({
        eachMessage: async ({ message }) => {
          let payload;
          try {
            payload = JSON.parse(message.value.toString());
          } catch {
            // Unparseable message. Retrying cannot fix it and throwing would
            // stall the partition behind it forever, so it is logged and acked.
            logger.error?.(`[events] ${topic}: message is not JSON, skipping`);
            return;
          }

          try {
            await handler(payload);
          } catch (error) {
            // Acked regardless. The handler is responsible for recording its
            // own failure durably -- for the metadata worker that means
            // `processingStatus: 'failed'` with a reason. Rethrowing here would
            // make kafkajs redeliver forever and block every later message on
            // the partition: one dead site would stop the whole pipeline.
            logger.error?.(`[events] ${topic}: handler failed:`, error.message);
          }
        },
      });
    },
  };
}
