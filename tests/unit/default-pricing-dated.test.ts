/**
 * membrane #121. Google publishes some Gemini rates together with the date
 * they change: gemini-4-argon at 2/10 "through November 30, 2026" and 4/20
 * "starting December 1, 2026", the 3.6 and 3.8 Flash models at 0.75/3.75
 * through December 31 and 1.50/7.50 from January 1, 2027. A table edited at
 * each date would stay wrong for every caller still running the version
 * before the edit, so a row carries each published change and the table
 * prices at the moment it is asked.
 *
 * Some Gemini ids that a text model's row matched by prefix are image or
 * speech models, whose output a text rate underprices. A row with no price
 * now says so, and those ids read as unpriced.
 *
 * Every rate below was read off https://ai.google.dev/gemini-api/docs/pricing
 * (Standard, paid tier) on 2026-10-14.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { resetUnpricedModelWarnings } from '../../src/utils/cost.js';
import {
  getDefaultPricing,
  PRICING_TABLE,
  GOOGLE_PRICING_LAST_VERIFIED,
} from '../../src/registry/default-pricing.js';
import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
  StreamCallbacks,
  NormalizedRequest,
  NormalizedResponse,
  ToolDefinition,
  ToolResult,
} from '../../src/types/index.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetUnpricedModelWarnings();
});

// Google names no time zone; the table takes Pacific midnight, UTC-8 on both
// dates. Each pair is the last millisecond before a change and its first.
const BEFORE_DEC_1 = new Date('2026-12-01T07:59:59.999Z');
const FROM_DEC_1 = new Date('2026-12-01T08:00:00.000Z');
const BEFORE_JAN_1 = new Date('2027-01-01T07:59:59.999Z');
const FROM_JAN_1 = new Date('2027-01-01T08:00:00.000Z');

const rates = (pricing: ReturnType<typeof getDefaultPricing>) => (
  pricing && [pricing.inputPerMillion, pricing.outputPerMillion, pricing.cacheReadPerMillion]
);

describe('every row of the table', () => {
  it('has a prefix no other row has', () => {
    const prefixes = PRICING_TABLE.map((row) => row.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('lists its changes as instants, in ascending order, each after its row was read', () => {
    for (const row of PRICING_TABLE) {
      if (row.pricing === null || !row.changes) continue;
      const read = Date.parse(row.pricing.asOf ?? '');
      expect(Number.isNaN(read), `${row.prefix}: a dated row says when it was read`).toBe(false);
      let previous = read;
      for (const change of row.changes) {
        // An offset or Z, so the instant doesn't depend on the host's zone.
        expect(change.from, row.prefix).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
        const from = Date.parse(change.from);
        expect(from, `${row.prefix}: ${change.from} comes after what precedes it`).toBeGreaterThan(previous);
        expect(change.pricing.currency, row.prefix).toBe(row.pricing.currency);
        expect(change.pricing.asOf, `${row.prefix}: a change carries its reading date too`).toBeDefined();
        previous = from;
      }
    }
  });

  it('has no price only where a shorter row would otherwise price its ids', () => {
    for (const row of PRICING_TABLE) {
      if (row.pricing !== null) continue;
      const shadowed = PRICING_TABLE.some((other) => (
        other.pricing !== null && other.prefix.length < row.prefix.length && row.prefix.startsWith(other.prefix)
      ));
      expect(shadowed, `${row.prefix} stands in front of a priced row`).toBe(true);
    }
  });
});

describe("Google's dated rates", () => {
  it('prices gemini-4-argon at its introductory rate through November 30, and double from December 1', () => {
    expect(rates(getDefaultPricing('gemini-4-argon', BEFORE_DEC_1))).toEqual([2, 10, 0.10]);
    expect(rates(getDefaultPricing('gemini-4-argon', FROM_DEC_1))).toEqual([4, 20, 0.20]);
  });

  it('prices gemini-3.8-flash and gemini-3.6-flash at theirs through December 31, and double from January 1', () => {
    for (const model of ['gemini-3.8-flash', 'gemini-3.6-flash']) {
      expect(rates(getDefaultPricing(model, BEFORE_JAN_1)), model).toEqual([0.75, 3.75, 0.075]);
      expect(rates(getDefaultPricing(model, FROM_JAN_1)), model).toEqual([1.50, 7.50, 0.15]);
    }
  });

  it('keeps the date the rates were read as asOf, on both sides of a change', () => {
    expect(GOOGLE_PRICING_LAST_VERIFIED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(getDefaultPricing('gemini-4-argon', BEFORE_DEC_1)?.asOf).toBe(GOOGLE_PRICING_LAST_VERIFIED);
    expect(getDefaultPricing('gemini-4-argon', FROM_DEC_1)?.asOf).toBe(GOOGLE_PRICING_LAST_VERIFIED);
  });

  it("prices at the moment it's asked when no instant is given", () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(BEFORE_DEC_1);
    expect(getDefaultPricing('gemini-4-argon')?.inputPerMillion).toBe(2);
    vi.setSystemTime(FROM_DEC_1);
    expect(getDefaultPricing('gemini-4-argon')?.inputPerMillion).toBe(4);
  });

  it('prices each routed model at the rate of the model Google routes it to', () => {
    // Google's deprecations table: requests for gemini-3.7-flash go to
    // gemini-3.8-flash, and requests for gemini-3.5-flash to gemini-3.6-flash.
    for (const at of [BEFORE_JAN_1, FROM_JAN_1]) {
      expect(getDefaultPricing('gemini-3.7-flash', at)).toEqual(getDefaultPricing('gemini-3.8-flash', at));
      expect(getDefaultPricing('gemini-3.5-flash', at)).toEqual(getDefaultPricing('gemini-3.6-flash', at));
    }
  });

  it('prices the Gemini models that had no row', () => {
    expect(rates(getDefaultPricing('gemini-3.1-pro-preview'))).toEqual([2, 12, 0.20]);
    expect(rates(getDefaultPricing('gemini-3.1-pro-preview-customtools'))).toEqual([2, 12, 0.20]);
    expect(rates(getDefaultPricing('gemini-3.1-flash-lite'))).toEqual([0.25, 1.50, 0.025]);
    expect(rates(getDefaultPricing('gemini-3-flash-preview'))).toEqual([0.50, 3, 0.05]);
  });

  it("keeps gemini-3.5-flash-lite out of the routed gemini-3.5-flash row", () => {
    expect(rates(getDefaultPricing('gemini-3.5-flash-lite'))).toEqual([0.30, 2.50, 0.03]);
  });
});

describe('ids a text row would underprice', () => {
  const unpriced = [
    'gemini-3.8-flash-tts',
    'gemini-3.8-flash-lite-tts',
    'gemini-3.1-flash-lite-image',
    'gemini-2.5-flash-image',
    'gemini-2.5-flash-preview-tts',
    'gemini-2.5-flash-native-audio-preview-12-2025',
    'gemini-2.5-pro-preview-tts',
  ];

  it('read as unpriced', () => {
    for (const model of unpriced) expect(getDefaultPricing(model), model).toBeUndefined();
  });

  it('leave the text rows they stand in front of priced', () => {
    for (const model of ['gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro']) {
      expect(getDefaultPricing(model)?.inputPerMillion, model).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Through Membrane: the rate in force when membrane prices the response.
// ---------------------------------------------------------------------------

/** 1M input, 100k output and 500k cache-read tokens per round. */
const ZZ_USAGE = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 500_000 };
/** ZZ_USAGE at gemini-4-argon's introductory rate: 2 + 1 + 0.05. */
const ARGON_INTRO_TOTAL = 3.05;
/** ZZ_USAGE at gemini-4-argon's rate from December 1: 4 + 2 + 0.10. */
const ARGON_LATER_TOTAL = 6.10;
/** ZZ_USAGE at the 3.8 and 3.6 Flash introductory rate: 0.75 + 0.375 + 0.0375. */
const FLASH_INTRO_TOTAL = 1.1625;
/** ZZ_USAGE at their rate from January 1: 1.50 + 0.75 + 0.075. */
const FLASH_LATER_TOTAL = 2.325;

const zzTool: ToolDefinition = {
  name: 'zz-noop',
  description: 'Forces a second round.',
  inputSchema: { type: 'object', properties: {} },
};

/**
 * Answers every call with ZZ_USAGE, naming `served` (or the requested id) as
 * the model that served it. With `rounds`, the first round asks for a tool,
 * and each round first moves the clock to its own instant.
 */
function zzAdapter(options: { served?: string; rounds?: Date[] } = {}): ProviderAdapter {
  let round = 0;
  const respond = (request: ProviderRequest): ProviderResponse => {
    const n = round++;
    const rounds = options.rounds;
    if (rounds) vi.setSystemTime(rounds[Math.min(n, rounds.length - 1)]!);
    const asksForTool = rounds !== undefined && n === 0;
    return {
      content: asksForTool
        ? [{ type: 'tool_use', id: 'zz-call-1', name: 'zz-noop', input: {} }]
        : [{ type: 'text', text: 'zz-reply' }],
      stopReason: asksForTool ? 'tool_use' : 'end_turn',
      usage: { ...ZZ_USAGE },
      model: options.served ?? request.model,
      rawRequest: request,
      raw: {},
    } as ProviderResponse;
  };
  return {
    name: 'zz-adapter',
    usageCacheConvention: 'cache-excluded',
    supportsModel: () => true,
    async complete(request: ProviderRequest) { return respond(request); },
    async stream(request: ProviderRequest, callbacks: StreamCallbacks) {
      const response = respond(request);
      if (response.stopReason !== 'tool_use') callbacks.onChunk('zz-reply');
      return response;
    },
  };
}

const zzRequest = (model: string, tools?: ToolDefinition[]) => ({
  config: { model, maxTokens: 64 },
  messages: [{ role: 'user', content: [{ type: 'text', text: 'zz-prompt' }] }],
  ...(tools ? { tools, toolMode: 'native' } : {}),
} as unknown as NormalizedRequest);

const zzResults = (calls: Array<{ id: string }>): ToolResult[] =>
  calls.map((c) => ({ toolUseId: c.id, content: 'zz-result', isError: false }));

const paths: Array<[string, (membrane: Membrane, request: NormalizedRequest) => Promise<NormalizedResponse>]> = [
  ['complete()', (membrane, request) => membrane.complete(request)],
  ['stream()', async (membrane, request) => await membrane.stream(request) as NormalizedResponse],
];

describe('through Membrane, on each side of each change', () => {
  for (const [label, call] of paths) {
    it(`prices gemini-4-argon at the rate in force on ${label}`, async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const membrane = new Membrane(zzAdapter());

      vi.setSystemTime(BEFORE_DEC_1);
      const before = await call(membrane, zzRequest('gemini-4-argon'));
      vi.setSystemTime(FROM_DEC_1);
      const after = await call(membrane, zzRequest('gemini-4-argon'));

      expect(before.details.usage.estimatedCost?.total).toBeCloseTo(ARGON_INTRO_TOTAL, 9);
      expect(before.details.usage.estimatedCost?.cacheRead).toBeCloseTo(0.05, 9);
      expect(after.details.usage.estimatedCost?.total).toBeCloseTo(ARGON_LATER_TOTAL, 9);
      expect(after.details.usage.estimatedCost?.cacheRead).toBeCloseTo(0.10, 9);
      expect(after.details.usage.estimatedCost?.pricingAsOf).toBe(GOOGLE_PRICING_LAST_VERIFIED);
    });

    it(`prices gemini-3.8-flash at the rate in force on ${label}`, async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const membrane = new Membrane(zzAdapter());

      vi.setSystemTime(BEFORE_JAN_1);
      const before = await call(membrane, zzRequest('gemini-3.8-flash'));
      vi.setSystemTime(FROM_JAN_1);
      const after = await call(membrane, zzRequest('gemini-3.8-flash'));

      expect(before.details.usage.estimatedCost?.total).toBeCloseTo(FLASH_INTRO_TOTAL, 9);
      expect(after.details.usage.estimatedCost?.total).toBeCloseTo(FLASH_LATER_TOTAL, 9);
    });

    it(`prices a routed gemini-3.5-flash request the same whichever id the response names, on ${label}`, async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(BEFORE_JAN_1);
      const namesTarget = await call(new Membrane(zzAdapter({ served: 'gemini-3.6-flash' })), zzRequest('gemini-3.5-flash'));
      const namesItself = await call(new Membrane(zzAdapter({ served: 'gemini-3.5-flash' })), zzRequest('gemini-3.5-flash'));

      expect(namesTarget.details.usage.estimatedCost?.total).toBeCloseTo(FLASH_INTRO_TOTAL, 9);
      expect(namesItself.details.usage.estimatedCost?.total).toBeCloseTo(FLASH_INTRO_TOTAL, 9);
    });

    it(`omits the cost of an image model a text row used to price, and says so once, on ${label}`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
      const response = await call(new Membrane(zzAdapter()), zzRequest('gemini-2.5-flash-image'));

      expect(response.details.usage.estimatedCost).toBeUndefined();
      expect(warn.mock.calls.filter((args) => String(args[0]).includes('gemini-2.5-flash-image'))).toHaveLength(1);
    });
  }

  it('prices each round of a turn that crosses December 1 at the rate of its own moment', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const membrane = new Membrane(zzAdapter({ rounds: [BEFORE_DEC_1, FROM_DEC_1] }));
    const response = await membrane.stream(zzRequest('gemini-4-argon', [zzTool]), {
      onToolCalls: async (calls) => zzResults(calls),
    }) as NormalizedResponse;

    const perRound = response.details.model.perRound;
    expect(perRound).toHaveLength(2);
    expect(perRound?.[0]?.usage.estimatedCost?.total).toBeCloseTo(ARGON_INTRO_TOTAL, 9);
    expect(perRound?.[1]?.usage.estimatedCost?.total).toBeCloseTo(ARGON_LATER_TOTAL, 9);
    expect(response.details.usage.estimatedCost?.total).toBeCloseTo(ARGON_INTRO_TOTAL + ARGON_LATER_TOTAL, 9);
  });
});
