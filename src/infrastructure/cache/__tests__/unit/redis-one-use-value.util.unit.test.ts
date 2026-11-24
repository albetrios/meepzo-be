import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import {
  consumeOneUseValue,
  generateOneUseToken,
  storeOneUseValue,
} from '@/infrastructure/cache/redis-one-use-value.util.js';

describe('redis one-use value', () => {
  it('makes 32-byte tokens in either encoding', () => {
    expect(generateOneUseToken('hex')).toMatch(/^[0-9a-f]{64}$/);
    expect(generateOneUseToken('base64url')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateOneUseToken('hex')).not.toBe(generateOneUseToken('hex'));
  });

  it('stores with SET … EX and uses with GETDEL', async () => {
    const redis = {
      set: vi.fn().mockResolvedValue('OK'),
      getdel: vi.fn().mockResolvedValueOnce('value').mockResolvedValueOnce(null),
    } as unknown as Redis;
    await storeOneUseValue({ redis, key: 'k', value: 'value', ttlSeconds: 60 });
    expect(redis.set).toHaveBeenCalledWith('k', 'value', 'EX', 60);
    await expect(consumeOneUseValue({ redis, key: 'k' })).resolves.toBe('value');
    await expect(consumeOneUseValue({ redis, key: 'k' })).resolves.toBeNull();
    expect(redis.getdel).toHaveBeenCalledWith('k');
  });

  it('reads an empty value as used', async () => {
    const redis = { getdel: vi.fn().mockResolvedValue('') } as unknown as Redis;
    await expect(consumeOneUseValue({ redis, key: 'k' })).resolves.toBeNull();
  });
});
