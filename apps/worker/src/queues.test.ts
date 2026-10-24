import { describe, expect, it } from 'vitest';
import { nextStage, redisConnection } from './queues';

describe('pipeline order', () => {
  it('chains stages and ends after ready-for-review', () => {
    expect(nextStage('scan')).toBe('extract');
    expect(nextStage('build-deliverables')).toBe('ready-for-review');
    expect(nextStage('ready-for-review')).toBeNull();
  });
});

describe('redisConnection', () => {
  it('reads host, port and database from a plain URL', () => {
    expect(redisConnection('redis://localhost:6379/3')).toEqual({
      host: 'localhost',
      port: 6379,
      db: 3,
    });
    expect(redisConnection('redis://localhost')).toEqual({ host: 'localhost', port: 6379, db: 0 });
  });

  it('keeps TLS and credentials for rediss:// (ElastiCache, D-115)', () => {
    expect(redisConnection('rediss://app:p%40ss@cache.example.internal:6380/0')).toEqual({
      host: 'cache.example.internal',
      port: 6380,
      db: 0,
      username: 'app',
      password: 'p@ss',
      tls: { servername: 'cache.example.internal' },
    });
  });
});
