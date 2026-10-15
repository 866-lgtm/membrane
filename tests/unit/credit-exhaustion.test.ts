/**
 * Account credit exhaustion (HTTP 402 / insufficient_credits) is transient.
 *
 * VoidAI and OpenRouter answer a request the account cannot currently afford
 * with `402 {"error":{"code":"insufficient_credits",...}}`. That used to fall
 * through every adapter's handleError into `unknown, retryable: false`, which
 * callers read as "this exact request fails forever": a context-manager merge
 * spent its whole five-attempt budget inside one second and went to the
 * durable merge quarantine on a credit dip that cleared two minutes later
 * (2026-10-15). The identical request succeeds once credits refill, so the
 * error is classified as a retryable rate_limit — the bucket OpenAI's own
 * insufficient_quota 429 already lands in — with its 402 status kept.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  MembraneError,
  classifyError,
  creditExhaustionError,
  isCreditExhaustion,
} from '../../src/types/errors.js';
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
    expect(isCreditExhaustion('Your credit balance is too low to access the API')).toBe(true);
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
    it(`${name} complete() rejects with rate_limit/402, retryable`, async () => {
      stubFetchStatus(402, VOIDAI_402_BODY);
      const adapter = build() as { complete: (request: unknown) => Promise<unknown> };
      const error = await adapter.complete(request).then(() => undefined, (e: unknown) => e);
      expect(error).toBeInstanceOf(MembraneError);
      expect((error as MembraneError).type).toBe('rate_limit');
      expect((error as MembraneError).retryable).toBe(true);
      expect((error as MembraneError).httpStatus).toBe(402);
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

describe('Membrane retries a credit dip instead of failing it as permanent', () => {
  const REQUEST: NormalizedRequest = {
    messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz hi' }] }],
    config: { model: 'zz-model', maxTokens: 16 },
  };
  const FAST = { retry: { maxRetries: 0, retryDelayMs: 1, backoffMultiplier: 1, maxRetryDelayMs: 1 } };

  it('recovers when credits refill between attempts', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      if (calls === 1) return new Response(VOIDAI_402_BODY, { status: 402 });
      return new Response(JSON.stringify({
        id: 'zz', object: 'chat.completion', model: 'zz-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'zz ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const membrane = new Membrane(
      new OpenAICompatibleAdapter({ baseURL: 'http://zz-host.invalid/v1', apiKey: 'zz-not-a-key' }),
      FAST,
    );
    const response = await membrane.complete(REQUEST);
    expect(calls).toBe(2);
    expect(response.content.some((block) => block.type === 'text')).toBe(true);
  });

  it('a persistent 402 still ends as a retryable MembraneError, so callers do not treat it as deterministic', async () => {
    const fetchMock = stubFetchStatus(402, VOIDAI_402_BODY);
    const membrane = new Membrane(
      new OpenAICompatibleAdapter({ baseURL: 'http://zz-host.invalid/v1', apiKey: 'zz-not-a-key' }),
      FAST,
    );
    const error = await membrane.complete(REQUEST).then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(MembraneError);
    expect((error as MembraneError).type).toBe('rate_limit');
    expect((error as MembraneError).retryable).toBe(true);
    expect((error as MembraneError).httpStatus).toBe(402);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });
});
