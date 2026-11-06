/**
 * Budget for tests that create or reload a real Pi runtime. Runtime startup and
 * resource reloads take several seconds on Windows dev machines and much longer
 * when the whole suite competes for the same disk and CPU, so the runner keeps
 * file concurrency low and these tests share one generous timeout.
 */
export const RUNTIME_TEST_TIMEOUT_MS = 60_000;

/** Budget for asynchronous driver events that must arrive after a fake run settles. */
export const EVENT_SETTLE_TIMEOUT_MS = 30_000;
