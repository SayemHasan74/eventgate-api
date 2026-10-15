import { beforeEach, describe, expect, it, vi } from 'vitest';

const { client, warn } = vi.hoisted(() => ({
  client: { isReady: true, isOpen: true, destroy: vi.fn(), on: vi.fn(), get: vi.fn() },
  warn: vi.fn(),
}));
vi.mock('redis', () => ({ createClient: () => client }));
vi.mock('../../src/config/env.js', () => ({ env: { REDIS_URL: 'redis://fixture.invalid' } }));
vi.mock('../../src/lib/logger.js', () => ({ logger: { warn } }));
const { readCache } = await import('../../src/lib/redis.js');

beforeEach(() => vi.clearAllMocks());

describe('optional discovery cache', () => {
  it('treats a failed GET as a cache miss instead of failing the API request', async () => {
    client.get.mockRejectedValueOnce(new Error('Redis connection closed'));
    await expect(readCache('fixture')).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('bounds an unresponsive cache command', async () => {
    vi.useFakeTimers();
    client.get.mockImplementationOnce(() => new Promise(() => {}));
    const result = readCache('stalled');
    await vi.advanceTimersByTimeAsync(501);
    await expect(result).resolves.toBeNull();
    expect(client.destroy).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('returns healthy cache values and ordinary cache misses', async () => {
    client.get.mockResolvedValueOnce('cached').mockResolvedValueOnce(null);
    await expect(readCache('fixture')).resolves.toBe('cached');
    await expect(readCache('missing')).resolves.toBeNull();
  });
});
