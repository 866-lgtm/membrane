/**
 * Membrane's retry decision, as plain functions with plain inputs, for every
 * layer that retries a provider call: membrane's core for the calls it
 * retries itself, and a caller that passes `retry: false` and retries its own
 * calls (agent-framework's turn policy and its storm hold, context-manager's
 * compression lane), each with its own settings. One decision means a call
 * path's classes, stated-wait rule and jitter are the same wherever it is
 * retried; only the numbers are each path's.
 *
 * It's the `@animalabs/membrane/retry` entry. It loads nothing of membrane at
 * run time but the default retry config's numbers (`types/config.ts`, which
 * imports types only), so taking it doesn't load a provider SDK.
 *
 * Three things are fixed here, not settings:
 * - the classes (classifyFailure);
 * - the stated-wait rule: a provider's stated wait (`retry-after`) only ever
 *   lengthens the backoff, and one past its schedule's ceiling isn't waited
 *   out but goes back to the caller (retryDecision);
 * - the jitter: equal jitter, a point in `[d/2, d)`, on the overloaded class
 *   only, since a capacity storm is where a fleet retrying in sync re-creates
 *   the stampede it's backing off from (delayFor).
 *
 * Attempts are counted as tries made so far: after a call's first send fails,
 * the attempt is 1, and the first retry waits the schedule's `firstDelayMs`.
 * A caller counting from 0 passes its count plus one.
 */

import { DEFAULT_RETRY_CONFIG, type RetryConfig } from './types/config.js';

/**
 * What a failed call is, for its retry:
 * - `deadline`: a deadline ran out on a request already sent, a call's own
 *   budget spent;
 * - `final`: not retryable;
 * - `overloaded`: a provider capacity error (a 529, or an overloaded error
 *   with no status);
 * - `rate_limited`: a rate limit;
 * - `retryable`: any other retryable failure (a 5xx, a 408, a connection
 *   failure).
 */
export type RetryClass = 'overloaded' | 'rate_limited' | 'retryable' | 'deadline' | 'final';

/** The facts classifyFailure reads, as membrane's ErrorInfo carries them. */
export interface FailureFacts {
  /** Whether the failure may be retried at all. */
  retryable: boolean;
  /** Membrane's error type, such as `'rate_limit'` or `'server'`. */
  type?: string;
  /** The HTTP status, when the failure had one. */
  httpStatus?: number;
  /** The failure's message, read for an overloaded error with no status. */
  message?: string;
  /** Whether a deadline ran out on a request already sent. */
  deadline?: boolean;
}

/**
 * One class's schedule. A retry after `attempt` tries waits
 * `min(firstDelayMs × multiplier^(attempt − 1), maxDelayMs)`, a zero
 * `firstDelayMs` staying zero.
 */
export interface RetrySchedule {
  /** The most tries in all, the first send included; `null` for no bound. */
  maxAttempts: number | null;
  firstDelayMs: number;
  multiplier: number;
  maxDelayMs: number;
  /** The longest stated wait waited out; `null` to wait out any, however long. */
  statedWaitCeilingMs: number | null;
}

/** A call path's schedules. A class with none isn't retried, except as
 *  retryDecision says for `overloaded`. */
export type RetrySettings = Partial<Record<RetryClass, RetrySchedule>>;

export type RetryDecision =
  | { retry: true; delayMs: number }
  /** `statedWaitMs`, when the stated wait was past its schedule's ceiling. */
  | { retry: false; statedWaitMs?: number };

/** A status-shaped 529, or Anthropic's overloaded error type, in a message. */
const OVERLOADED_PATTERN = /\b529\b|overloaded_error/i;

/**
 * The longest stated wait waited out on a schedule whose own maxDelayMs is
 * shorter: a minute. AnthropicAdapter's SDK client, whose retries membrane
 * took over, waited out a stated wait under a minute (SDK 0.52's
 * `retryRequest`).
 */
const STATED_WAIT_CEILING_MS = 60_000;

/**
 * Whether a retryable failure is a provider capacity error: by its status
 * when it has one (a 529), and by its message only when it has none, such as
 * an overloaded error that arrives mid-stream, after the 200. classifyFailure
 * asks it only once a failure is known to be retryable.
 */
function isOverloadedFailure(facts: Pick<FailureFacts, 'httpStatus' | 'message'>): boolean {
  if (facts.httpStatus !== undefined) return facts.httpStatus === 529;
  return OVERLOADED_PATTERN.test(facts.message ?? '');
}

/**
 * The class of a failure. A deadline that ran out on a sent request comes
 * first, whatever else is said of it; then a failure that isn't retryable;
 * then an overloaded error, then a rate limit, then any other retryable
 * failure.
 */
export function classifyFailure(facts: FailureFacts): RetryClass {
  if (facts.deadline === true) return 'deadline';
  if (!facts.retryable) return 'final';
  if (isOverloadedFailure(facts)) return 'overloaded';
  if (facts.type === 'rate_limit') return 'rate_limited';
  return 'retryable';
}

/** The schedule a class is retried on, and whether its delays are jittered:
 *  an overloaded failure whose settings have no overloaded schedule takes the
 *  retryable schedule, with no jitter. */
function scheduleFor(cls: RetryClass, settings: RetrySettings): { schedule?: RetrySchedule; jitter: boolean } {
  if (cls === 'overloaded') {
    return settings.overloaded
      ? { schedule: settings.overloaded, jitter: true }
      : { schedule: settings.retryable, jitter: false };
  }
  return { schedule: settings[cls], jitter: false };
}

/**
 * How long to wait before a retry after `attempt` tries, with no stated wait:
 * `nominalMs` is the schedule's un-jittered step, and `delayMs` the wait, the
 * same as `nominalMs` but on the overloaded class, where it's a point in
 * `[nominalMs/2, nominalMs)` drawn with `random` (Math.random by default).
 * It answers "how long" alone, not "whether": a caller that holds rather than
 * gives up, such as a storm, asks it for each held call's own draw. It throws
 * for a class with no schedule, or an attempt that isn't a finite number.
 */
export function delayFor(
  cls: RetryClass,
  attempt: number,
  settings: RetrySettings,
  random: () => number = Math.random,
): { delayMs: number; nominalMs: number } {
  const { schedule, jitter } = scheduleFor(cls, settings);
  if (!schedule) throw new RangeError(`[membrane] no retry schedule for the ${cls} class`);
  if (!Number.isFinite(attempt)) throw new RangeError(`[membrane] a retry's attempt is a count of tries, not ${attempt}`);
  // A zero first delay stays zero: times a power that overflowed to Infinity
  // it would be NaN, which would discard a stated wait.
  const nominalMs = schedule.firstDelayMs === 0
    ? 0
    : Math.min(schedule.firstDelayMs * Math.pow(schedule.multiplier, attempt - 1), schedule.maxDelayMs);
  const delayMs = jitter ? Math.floor(nominalMs / 2 + random() * (nominalMs / 2)) : nominalMs;
  return { delayMs, nominalMs };
}

/**
 * Whether a call that failed in class `cls`, after `attempt` tries, is sent
 * again, and after how long. Not when its class has no schedule, when its
 * attempts are spent, or when the provider's stated wait is past its
 * schedule's ceiling: then the stated wait goes back as `statedWaitMs`, for
 * the caller to wait out or to end on. Otherwise the wait is the backoff, or the
 * stated wait where that's longer: a stated wait never shortens the backoff,
 * even where a schedule's maxDelayMs is past its ceiling. A stated wait is
 * read as a number, so a numeric string, which another adapter's error might
 * carry, counts as its number; one that reads as NaN counts as none. A zero or
 * negative one loses to the backoff, so it can't make the retries spin.
 */
export function retryDecision(
  cls: RetryClass,
  attempt: number,
  statedWaitMs: number | undefined,
  settings: RetrySettings,
  random: () => number = Math.random,
): RetryDecision {
  const { schedule } = scheduleFor(cls, settings);
  if (!schedule) return { retry: false };
  // Written to fail closed: an attempt that isn't a finite count, or a bound
  // that compares false with every count, ends the retries rather than
  // letting them run on, bound or none (a NaN wait would run at once).
  if (!Number.isFinite(attempt)) return { retry: false };
  if (schedule.maxAttempts !== null && !(attempt < schedule.maxAttempts)) return { retry: false };
  // Number(undefined) is NaN, so no stated wait reads as none.
  const read = Number(statedWaitMs);
  const stated = Number.isNaN(read) ? undefined : read;
  const ceiling = schedule.statedWaitCeilingMs;
  if (stated !== undefined && ceiling !== null && stated > ceiling) return { retry: false, statedWaitMs: stated };
  const { delayMs: backoffMs } = delayFor(cls, attempt, settings, random);
  if (stated === undefined) return { retry: true, delayMs: backoffMs };
  return { retry: true, delayMs: Math.max(backoffMs, stated) };
}

/**
 * Membrane's own settings for a retry config, as its core retries a call:
 * - `retryable`: `maxRetries` attempts on the base schedule;
 * - `rate_limited`: the base schedule, with at least 5 attempts, so a
 *   transient rate limit doesn't end a call whatever `maxRetries` says;
 * - `overloaded`: the overloaded schedule, with the larger of the two
 *   attempt counts, or none when `overloaded.maxRetries` is 0, so a 529 is
 *   then retried as any other retryable failure;
 * - `deadline` and `final`: none.
 * A schedule's stated-wait ceiling is a minute, or its maxDelayMs where
 * that's longer. It takes a complete RetryConfig, as Membrane's constructor
 * resolves and checks one from MembraneConfig.retry; it fills and checks
 * nothing itself.
 */
export function membraneRetrySettings(config: RetryConfig): RetrySettings {
  const base = {
    firstDelayMs: config.retryDelayMs,
    multiplier: config.backoffMultiplier,
    maxDelayMs: config.maxRetryDelayMs,
    statedWaitCeilingMs: Math.max(STATED_WAIT_CEILING_MS, config.maxRetryDelayMs),
  };
  const overloaded = config.overloaded;
  return {
    retryable: { ...base, maxAttempts: config.maxRetries },
    rate_limited: { ...base, maxAttempts: Math.max(config.maxRetries, 5) },
    ...(overloaded.maxRetries > 0
      ? {
          overloaded: {
            maxAttempts: Math.max(config.maxRetries, overloaded.maxRetries),
            firstDelayMs: overloaded.retryDelayMs,
            multiplier: overloaded.backoffMultiplier,
            maxDelayMs: overloaded.maxRetryDelayMs,
            statedWaitCeilingMs: Math.max(STATED_WAIT_CEILING_MS, overloaded.maxRetryDelayMs),
          },
        }
      : {}),
  };
}

/** Membrane's settings for its default retry config (DEFAULT_RETRY_CONFIG),
 *  for a layer that starts from membrane's own numbers. Frozen, schedules and
 *  all, since every importer in a process shares it: spread it to change it. */
export const MEMBRANE_RETRY_SETTINGS: { readonly [K in RetryClass]?: Readonly<RetrySchedule> } = Object.freeze(
  Object.fromEntries(
    Object.entries(membraneRetrySettings(DEFAULT_RETRY_CONFIG)).map(([cls, schedule]) => [cls, Object.freeze(schedule)]),
  ) as RetrySettings,
);
