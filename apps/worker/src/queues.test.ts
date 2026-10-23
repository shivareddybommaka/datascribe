import { describe, expect, it } from 'vitest';
import { nextStage } from './queues';

describe('pipeline order', () => {
  it('chains stages and ends after ready-for-review', () => {
    expect(nextStage('scan')).toBe('extract');
    expect(nextStage('build-deliverables')).toBe('ready-for-review');
    expect(nextStage('ready-for-review')).toBeNull();
  });
});
