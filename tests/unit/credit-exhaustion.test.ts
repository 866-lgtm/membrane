/**
 * Account credit exhaustion (HTTP 402 / insufficient_credits /
 * insufficient_quota / payment_required) is transient.
 *
 * OpenAI-compatible gateways and OpenRouter answer a request the account
 * cannot currently afford with `402 {"error":{"code":"insufficient_credits",...}}`;
 * OpenAI answers 429 `insufficient_quota`. Typed non-retryable (`auth` for the
 * 402, a non-retryable 429 for the quota), callers read it as "this exact
 * request fails forever": a context-manager merge spent its whole
 * five-attempt budget inside one second and went to the durable merge
 * quarantine on a credit dip that cleared two minutes later. The identical
 * request succeeds once credits refill, so the error is a retryable
 * rate_limit with its status kept and a wait on retryAfterMs (the provider's,
 * or CREDIT_EXHAUSTION_RETRY_AFTER_MS), marked creditExhausted.
 *
 * Membrane's own retries leave it to the caller: they would wait out that
 * minute and send again up to the 429 floor of five tries, holding the call
 * for minutes inside the hold the caller places on the same wait. The caller
 * (a framework's provider hold, a compression lane's backoff) pauses and
 * sends again.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  MembraneError,
  classifyError,
  creditExhaustionError,
  isCreditExhaustion,
  CREDIT_EXHAUSTION_RETRY_AFTER_MS,
} from '../../src/types/errors.js';
import { classifyFailure, retryDecision, MEMBRANE_RETRY_SETTINGS, type RetrySettings } from '../../src/retry.js';
import { throwOnStreamErrorFrame } from '../../src/providers/utils.js';
import { Membrane } from '../../src/membrane.js';
import { OpenAICompatibleAdapter } from '../../src/providers/openai-compatible.js';
import { OpenAICompletionsAdapter } from '../../src/providers/openai-completions.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { OpenAIResponsesAPIAdapter } from '../../src/providers/openai-responses-api.js';
import type { NormalizedRequest } from '../../src/types/index.js';

afterEach(() => vi.unstubAllGlobals());

/** The body VoidAI returned on 2026-10-15, verbatim. */
const VOIDAI_402_BODY = JSON.stringify({
  error: {
    message: 'Insufficient credits. You have 241833 credits remaining.',
    type: 'api_error',
    code: 'insufficient_credits',
  },
});
const VOIDAI_402_MESSAGE = `API error: 402 ${VOIDAI_402_BODY}`;

function stubFetchStatus(status: number, body: string): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(body, { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('isCreditExhaustion', () => {
  it('matches the live VoidAI 402', () => {
    expect(isCreditExhaustion(VOIDAI_402_MESSAGE)).toBe(true);
  });

  it('matches a 402 however the adapters and the OpenAI SDK spell the status', () => {
    expect(isCreditExhaustion('OpenRouter error: 402 {"error":{"message":"This request requires more credits"}}')).toBe(true);
    expect(isCreditExhaustion('OpenAI API error: 402 payment needed')).toBe(true);
    expect(isCreditExhaustion('402 This request requires more credits')).toBe(true);
    expect(isCreditExhaustion('{"error":{"code": 402,"message":"no funds"}}')).toBe(true);
    expect(isCreditExhaustion('anything', 402)).toBe(true);
  });

  it('matches the providers\' own codes without a status', () => {
    expect(isCreditExhaustion('You exceeded your current quota [insufficient_quota]')).toBe(true);
    expect(isCreditExhaustion('Payment Required')).toBe(true);
    expect(isCreditExhaustion('zz', undefined, 'insufficient_credits')).toBe(true);
  });

  it('leaves the account refusals that are not credit codes to their own types', () => {
    // Anthropic's 400 "credit balance is too low" stays `auth`, as upstream
    // types it; so do the other billing codes.
    expect(isCreditExhaustion('Your credit balance is too low to access the API')).toBe(false);
    expect(isCreditExhaustion('zz', 429, 'billing_hard_limit_reached')).toBe(false);
  });

  it('never matches a bare 402 in prose', () => {
    expect(isCreditExhaustion('max_tokens must be <= 4020')).toBe(false);
    expect(isCreditExhaustion('API error: 400 messages[402] is malformed')).toBe(false);
    expect(isCreditExhaustion('summary was 402 tokens over target')).toBe(false);
    expect(isCreditExhaustion('API error: 500 internal')).toBe(false);
  });
});

describe('creditExhaustionError', () => {
  it('is a retryable rate_limit carrying 402 and the provider code', () => {
    const err = creditExhaustionError(VOIDAI_402_MESSAGE);
    expect(err).toBeInstanceOf(MembraneError);
    expect(err.type).toBe('rate_limit');
    expect(err.retryable).toBe(true);
    expect(err.httpStatus).toBe(402);
    expect(err.providerErrorCode).toBe('insufficient_credits');
    expect(err.message).toBe(VOIDAI_402_MESSAGE);
    expect(err.retryAfterMs).toBe(CREDIT_EXHAUSTION_RETRY_AFTER_MS);
    expect(err.creditExhausted).toBe(true);
  });

  it('keeps 429 for OpenAI insufficient_quota, which arrives as a 429', () => {
    const err = creditExhaustionError('API error: 429 {"error":{"code":"insufficient_quota"}}');
    expect(err.httpStatus).toBe(429);
    expect(err.providerErrorCode).toBe('insufficient_quota');
  });
});

describe('classifyError fallback', () => {
  it('classifies an unadapted 402 Error as a retryable rate_limit', () => {
    const info = classifyError(new Error(VOIDAI_402_MESSAGE));
    expect(info.type).toBe('rate_limit');
    expect(info.retryable).toBe(true);
    expect(info.httpStatus).toBe(402);
    expect(info.retryAfterMs).toBe(CREDIT_EXHAUSTION_RETRY_AFTER_MS);
    expect(info.creditExhausted).toBe(true);
  });
});

describe('throwOnStreamErrorFrame credit frames', () => {
  const thrownBy = (payload: unknown): MembraneError => {
    try {
      throwOnStreamErrorFrame({ error: payload }, 'zz-provider-1');
    } catch (thrown) {
      return thrown as MembraneError;
    }
    throw new Error('expected a throw');
  };

  it('classifies a numeric 402 frame', () => {
    const err = thrownBy({ code: 402, message: 'zz out of credits' });
    expect(err).toBeInstanceOf(MembraneError);
    expect(err.type).toBe('rate_limit');
    expect(err.retryable).toBe(true);
    expect(err.httpStatus).toBe(402);
    expect(err.message).toContain('zz out of credits');
  });

  it('classifies an insufficient_credits code without a status', () => {
    const err = thrownBy({ code: 'insufficient_credits', message: 'zz out of credits' });
    expect(err.type).toBe('rate_limit');
    expect(err.retryable).toBe(true);
    expect(err.httpStatus).toBe(402);
    expect(err.creditExhausted).toBe(true);
    expect(err.retryAfterMs).toBe(CREDIT_EXHAUSTION_RETRY_AFTER_MS);
  });

  it('classifies an insufficient_quota frame, keeping its 429', () => {
    const err = thrownBy({ code: 429, type: 'insufficient_quota', message: 'zz quota' });
    expect(err).toMatchObject({ type: 'rate_limit', retryable: true, httpStatus: 429, providerErrorCode: 'insufficient_quota', creditExhausted: true });
  });
});

describe('OpenAI-family adapters surface a 402 as retryable', () => {
  const request = { model: 'zz-model', messages: [{ role: 'user', content: 'zz hello' }], maxTokens: 16 };
  const adapters: [string, () => unknown][] = [
    ['openai-compatible', () => new OpenAICompatibleAdapter({ baseURL: 'http://zz-host.invalid/v1', apiKey: 'zz-not-a-key' })],
    ['openai-completions', () => new OpenAICompletionsAdapter({ baseURL: 'http://zz-host.invalid/v1', apiKey: 'zz-not-a-key' })],
    ['openrouter', () => new OpenRouterAdapter({ apiKey: 'zz-not-a-key' })],
    ['openai', () => new OpenAIAdapter({ apiKey: 'zz-not-a-key' })],
    ['openai-responses-api', () => new OpenAIResponsesAPIAdapter({ apiKey: 'zz-not-a-key' })],
  ];

  for (const [name, build] of adapters) {
    it(`${name} complete() rejects with rate_limit/402, retryable, with a wait`, async () => {
      stubFetchStatus(402, VOIDAI_402_BODY);
      const adapter = build() as { complete: (request: unknown) => Promise<unknown> };
      const error = await adapter.complete(request).then(() => undefined, (e: unknown) => e);
      expect(error).toBeInstanceOf(MembraneError);
      expect((error as MembraneError).type).toBe('rate_limit');
      expect((error as MembraneError).retryable).toBe(true);
      expect((error as MembraneError).httpStatus).toBe(402);
      expect((error as MembraneError).providerErrorCode).toBe('insufficient_credits');
      expect((error as MembraneError).retryAfterMs).toBe(CREDIT_EXHAUSTION_RETRY_AFTER_MS);
      expect((error as MembraneError).creditExhausted).toBe(true);
    });
  }

  it('openai-compatible handleError classifies the live message directly', () => {
    const adapter = new OpenAICompatibleAdapter({ baseURL: 'http://zz-host.invalid/v1', apiKey: 'zz-not-a-key' });
    const err = (adapter as unknown as { handleError(e: unknown): MembraneError }).handleError(new Error(VOIDAI_402_MESSAGE));
    expect(err.type).toBe('rate_limit');
    expect(err.retryable).toBe(true);
    expect(err.httpStatus).toBe(402);
    expect(err.providerErrorCode).toBe('insufficient_credits');
  });
});

describe('a stated wait is kept', () => {
  it('reads a retry-after header on a 402', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(VOIDAI_402_BODY, { status: 402, headers: { 'retry-after': '7' } })));
    const adapter = new OpenAICompatibleAdapter({ baseURL: 'http://zz-host.invalid/v1', apiKey: 'zz-not-a-key' });
    const error = await adapter.complete({ model: 'zz-model', messages: [], maxTokens: 16 } as any).then(() => undefined, (e: unknown) => e);
    expect((error as MembraneError).retryAfterMs).toBe(7_000);
  });

  it('reads the wait OpenAI states in prose on insufficient_quota', async () => {
    stubFetchStatus(429, JSON.stringify({ error: { code: 'insufficient_quota', message: 'You exceeded your current quota. Please retry after 20 seconds.' } }));
    const error = await new OpenAIAdapter({ apiKey: 'zz-not-a-key' })
      .complete({ model: 'gpt-4o', messages: [], maxTokens: 16 } as any).then(() => undefined, (e: unknown) => e);
    expect(error).toMatchObject({ type: 'rate_limit', retryable: true, httpStatus: 429, retryAfterMs: 20_000, creditExhausted: true });
  });
});

describe('Membrane leaves a credit dip to the caller that holds on it', () => {
  const REQUEST: NormalizedRequest = {
    messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz hi' }] }],
    config: { model: 'zz-model', maxTokens: 16 },
  };
  const okBody = () => new Response(JSON.stringify({
    id: 'zz', object: 'chat.completion', model: 'zz-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'zz ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const build = (config: ConstructorParameters<typeof Membrane>[1] = {}) => new Membrane(
    new OpenAICompatibleAdapter({ baseURL: 'http://zz-host.invalid/v1', apiKey: 'zz-not-a-key' }),
    config,
  );

  it('hands a 402 back after one send under the default retry config: no in-call wait, no 429 floor, no onError', async () => {
    const fetchMock = stubFetchStatus(402, VOIDAI_402_BODY);
    const onError = vi.fn(() => 'retry' as const);
    const started = Date.now();
    const error = await build({ hooks: { onError } }).complete(REQUEST).then(() => undefined, (e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(MembraneError);
    expect(error).toMatchObject({
      type: 'rate_limit', retryable: true, httpStatus: 402, providerErrorCode: 'insufficient_credits',
      retryAfterMs: CREDIT_EXHAUSTION_RETRY_AFTER_MS, creditExhausted: true,
    });
  });

  it('does the same with retry: false on the call', async () => {
    const fetchMock = stubFetchStatus(402, VOIDAI_402_BODY);
    const error = await build().complete(REQUEST, { retry: false }).then(() => undefined, (e: unknown) => e);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ type: 'rate_limit', retryable: true, creditExhausted: true });
  });

  it('hands back an insufficient_quota SSE frame from stream() after one send', async () => {
    const sse = 'data: ' + JSON.stringify({ error: { code: 429, type: 'insufficient_quota', message: 'zz quota' } }) + '\n\n';
    const fetchMock = vi.fn(async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await build().stream(REQUEST, { onChunk() {} }).then((r) => r, (e: unknown) => e);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ type: 'rate_limit', retryable: true, creditExhausted: true });
  });

  it('an ordinary 429 is still retried by membrane, as before', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => (++calls === 1
      ? new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'zz slow down' } }), { status: 429, headers: { 'retry-after': '0' } })
      : okBody())));
    const response = await build({ retry: { retryDelayMs: 1, maxRetryDelayMs: 1 } }).complete(REQUEST);
    expect(calls).toBe(2);
    expect(response.content.some((block) => block.type === 'text')).toBe(true);
  });

  it('a caller that holds on the stated wait and sends again recovers once credits refill', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => (++calls === 1 ? new Response(VOIDAI_402_BODY, { status: 402 }) : okBody())));
    const membrane = build();
    const first = await membrane.complete(REQUEST).then(() => undefined, (e: unknown) => e) as MembraneError;
    expect(first.retryAfterMs).toBe(CREDIT_EXHAUSTION_RETRY_AFTER_MS);
    const response = await membrane.complete(REQUEST);
    expect(calls).toBe(2);
    expect(response.content.some((block) => block.type === 'text')).toBe(true);
  });

  it("a caller deciding with membrane's retry module retries it as a rate limit after the stated minute", () => {
    // A caller layer (agent-framework's error policy, which passes retry:
    // false) classifies the error as membrane does and waits the stated wait.
    const error = creditExhaustionError(VOIDAI_402_MESSAGE);
    const cls = classifyFailure({ retryable: error.retryable, type: error.type, httpStatus: error.httpStatus, message: error.message });
    expect(cls).toBe('rate_limited');
    expect(retryDecision(cls, 1, error.retryAfterMs, MEMBRANE_RETRY_SETTINGS as RetrySettings))
      .toEqual({ retry: true, delayMs: CREDIT_EXHAUSTION_RETRY_AFTER_MS });
  });
});
