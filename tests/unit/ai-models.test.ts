import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
vi.mock('../../src/lib/redis.js', () => ({
  readCache: async () => null,
  writeCache: async () => undefined,
  reserveAiQuota: async () => true,
}));
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('GEMINI_API_KEY', 'fixture-key');
  vi.stubEnv('GEMINI_MODEL', 'auto');
  vi.stubEnv('LOG_LEVEL', 'fatal');
});
describe('free model availability selection', () => {
  it('selects only a documented free model with generation support, never a paid-only model', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          models: [
            { name: 'models/gemini-4-argon', supportedGenerationMethods: ['generateContent'] },
            {
              name: 'models/gemini-3.1-flash-lite',
              supportedGenerationMethods: ['generateContent'],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"ok":true}' }] } }],
        }),
      );
    vi.stubGlobal('fetch', fetcher);
    const { generateJson } = await import('../../src/modules/ai/ai.provider.js');
    expect(
      (await generateJson('selection', {}, z.object({ ok: z.boolean() }), 'rules')).value.ok,
    ).toBe(true);
    expect(String(fetcher.mock.calls[1]![0])).toContain('/gemini-3.1-flash-lite:generateContent');
  });
  it('stops before inference when only paid or incompatible models are available', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        models: [
          { name: 'models/gemini-4-argon', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['embedContent'] },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    const { generateJson } = await import('../../src/modules/ai/ai.provider.js');
    await expect(generateJson('selection', {}, z.object({}), 'rules')).rejects.toMatchObject({
      code: 'AI_FREE_MODEL_UNAVAILABLE',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
