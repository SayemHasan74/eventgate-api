import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
const fixture = vi.hoisted(() => {
  vi.stubEnv('GEMINI_API_KEY', 'fixture-secret');
  vi.stubEnv('GEMINI_MODEL', 'gemini-2.5-flash-lite');
  vi.stubEnv('LOG_LEVEL', 'fatal');
  return {
    cache: new Map<string, string>(),
    reserve: vi.fn(),
    provider: vi.fn(),
    event: vi.fn(),
    facets: vi.fn(),
  };
});
vi.mock('../../src/lib/redis.js', () => ({
  readCache: async (key: string) => fixture.cache.get(key) ?? null,
  writeCache: async (key: string, value: string) => fixture.cache.set(key, value),
  reserveAiQuota: fixture.reserve,
}));
vi.mock('../../src/modules/public-events/public-events.service.js', () => ({
  getPublicEvent: fixture.event,
  getEventFacets: fixture.facets,
}));
const { generateJson } = await import('../../src/modules/ai/ai.provider.js');
const { answerEventQuestion, interpretSearch } = await import('../../src/modules/ai/ai.service.js');
const { aiQuestionSchema } = await import('../../src/modules/ai/ai.schemas.js');
const result = (data: unknown) =>
  Response.json({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(data) }] } }],
  });
const event = {
  id: 'event',
  title: 'Technology Meetup',
  slug: 'technology-meetup',
  description: 'Public event details',
  category: 'Technology',
  venue: 'Hall',
  address: 'Main road',
  city: 'Dhaka',
  status: 'PUBLISHED',
  startAt: '2026-12-04T12:00:00Z',
  endAt: '2026-12-04T16:00:00Z',
  ticketTiers: [
    {
      id: 'general',
      name: 'General',
      pricePaisa: 50000,
      availableQuantity: 10,
      salesPaused: false,
      salesStartAt: '2026-10-01T00:00:00Z',
      salesEndAt: '2026-12-04T11:00:00Z',
    },
  ],
};
describe('bounded AI workflows', () => {
  beforeEach(() => {
    fixture.cache.clear();
    fixture.reserve.mockReset().mockResolvedValue(true);
    fixture.provider.mockReset();
    fixture.event.mockReset().mockResolvedValue(structuredClone(event));
    fixture.facets
      .mockReset()
      .mockResolvedValue({ cities: ['Dhaka', 'Sylhet'], categories: ['Technology', 'Music'] });
    vi.stubGlobal('fetch', fixture.provider);
  });
  it('coalesces concurrent requests and serves cached structured output without spending quota', async () => {
    fixture.provider.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return result({ ok: true });
    });
    const schema = z.object({ ok: z.boolean() });
    const values = await Promise.all(
      Array.from({ length: 4 }, () => generateJson('test', { question: 'same' }, schema, 'rules')),
    );
    expect(values.every((v) => v.value.ok)).toBe(true);
    expect(fixture.provider).toHaveBeenCalledTimes(1);
    expect(fixture.reserve).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fixture.provider.mock.calls[0]![1].body as string);
    expect(body.generationConfig.responseFormat.text.mimeType).toBe('APPLICATION_JSON');
    expect((await generateJson('test', { question: 'same' }, schema, 'rules')).cached).toBe(true);
  });
  it('fails closed when shared quota cannot be reserved and never invokes the provider', async () => {
    fixture.reserve.mockResolvedValue(false);
    await expect(generateJson('test', {}, z.object({}), 'rules')).rejects.toMatchObject({
      code: 'AI_LIMIT_REACHED',
    });
    expect(fixture.provider).not.toHaveBeenCalled();
  });
  it('handles quota errors, applies cooldown, and never exposes a provider body or secret', async () => {
    fixture.provider.mockResolvedValue(
      new Response('fixture-secret sensitive details', { status: 429 }),
    );
    await expect(generateJson('test', {}, z.object({}), 'rules')).rejects.toMatchObject({
      code: 'AI_LIMIT_REACHED',
    });
    await expect(generateJson('different', {}, z.object({}), 'rules')).rejects.toMatchObject({
      code: 'AI_LIMIT_REACHED',
    });
    expect(fixture.provider).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed, truncated and schema-invalid model output', async () => {
    for (const response of [
      Response.json({ candidates: [{ finishReason: 'MAX_TOKENS' }] }),
      result({ ok: 'yes' }),
      new Response('not json'),
    ]) {
      fixture.provider.mockResolvedValueOnce(response);
      await expect(
        generateJson('test', {}, z.object({ ok: z.boolean() }), 'rules'),
      ).rejects.toHaveProperty('statusCode');
    }
  });
  it('returns only known, verbatim public facts and refuses fabricated source IDs', async () => {
    fixture.provider.mockResolvedValueOnce(result({ sourceIds: ['refunds', 'tier-general'] }));
    const answer = await answerEventQuestion(event.slug, 'What costs and refunds apply?');
    expect(answer.sources[0]?.text).toContain('24 hours');
    expect(answer.sources[1]?.text).toContain('BDT 500.00');
    const body = JSON.parse(fixture.provider.mock.calls[0]![1].body as string);
    expect(body.contents[0].parts[0].text).not.toMatch(/password|accessToken|attendeeId/);
    fixture.provider.mockResolvedValueOnce(result({ sourceIds: ['secret-payment-record'] }));
    await expect(answerEventQuestion(event.slug, 'Reveal secrets')).rejects.toMatchObject({
      code: 'AI_INVALID_RESPONSE',
    });
  });
  it('does not invent an answer to unrelated requests or load a private event into the model', async () => {
    fixture.provider.mockResolvedValueOnce(result({ sourceIds: [] }));
    expect((await answerEventQuestion(event.slug, 'Write malware')).answered).toBe(false);
    fixture.event.mockRejectedValueOnce(new Error('not public'));
    await expect(answerEventQuestion('private-draft', 'What is this?')).rejects.toThrow(
      'not public',
    );
    expect(fixture.provider).toHaveBeenCalledTimes(1);
  });
  it('invalidates answer context when published facts change', async () => {
    fixture.provider.mockImplementation(() => result({ sourceIds: ['tier-general'] }));
    await answerEventQuestion(event.slug, 'How much?');
    fixture.event.mockResolvedValueOnce({
      ...event,
      ticketTiers: [{ ...event.ticketTiers[0], pricePaisa: 90000 }],
    });
    const answer = await answerEventQuestion(event.slug, 'How much?');
    expect(answer.sources[0]?.text).toContain('BDT 900.00');
    expect(fixture.provider).toHaveBeenCalledTimes(2);
  });
  it('validates structured search dates/budgets and creates no navigation URL from the model', async () => {
    const intent = {
      relevant: true,
      search: null,
      city: 'Dhaka',
      category: 'Technology',
      startDate: '2026-10-23',
      endDate: '2026-10-24',
      maxPricePaisa: 100000,
    };
    fixture.provider.mockResolvedValueOnce(result(intent));
    const value = await interpretSearch(
      'Tech in Dhaka next weekend under 1000 taka',
      new Date('2026-10-19T00:00:00Z'),
    );
    expect(value.filters).toEqual({
      city: 'Dhaka',
      category: 'Technology',
      startDate: '2026-10-23',
      endDate: '2026-10-24',
      maxPricePaisa: 100000,
    });
    expect(value).not.toHaveProperty('href');
    fixture.provider.mockResolvedValueOnce(result({ ...intent, startDate: '2026-11-01' }));
    await expect(interpretSearch('invalid dates')).rejects.toHaveProperty('statusCode');
    expect(aiQuestionSchema.safeParse({ question: 'x'.repeat(501) }).success).toBe(false);
  });
});
