/**
 * The mechanism both entrypoints use to stop.
 *
 * Extracted because there are two processes and the parts that are easy to get
 * wrong are identical in both: ignoring a second signal, bounding how long the
 * wind-down may take, and never letting a throw halfway through skip the exit.
 * What differs between them is only *what* gets stopped and in what order, and
 * that stays where it is legible -- in the entrypoint, as a list.
 */
export function createShutdown({ timeoutMs, steps, logger = console } = {}) {
  let shuttingDown = false;

  return async function shutdown(signal) {
    // A second signal -- an impatient Ctrl-C -- must not restart the sequence.
    if (shuttingDown) return;
    shuttingDown = true;

    logger.log?.(`\n${signal} received, shutting down...`);

    /**
     * Not optional. Any step can hang -- a socket that will not close, a model
     * call that will not return -- and Render follows SIGTERM with SIGKILL
     * regardless. Exiting on our own terms with a log line beats being killed
     * mid-sentence with none.
     */
    const backstop = setTimeout(() => {
      logger.warn?.(`Shutdown did not finish within ${timeoutMs}ms, exiting anyway`);
      process.exit(1);
    }, timeoutMs);

    // Never hold the process open for the thing whose job is to end it.
    backstop.unref?.();

    try {
      for (const step of steps) {
        await step();
      }
      logger.log?.('Shutdown complete');
    } catch (error) {
      // Logged, not rethrown. A failure to close one thing cleanly is not a
      // reason to skip the exit and let the platform kill us instead.
      logger.error?.('Error during shutdown:', error);
    }

    clearTimeout(backstop);
    process.exit(0);
  };
}

/** Wires a shutdown to the two signals a container is stopped with. */
export function listenForShutdown(shutdown) {
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
