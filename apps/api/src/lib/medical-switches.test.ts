import type { PrismaClient } from '@datascribe/db';
import { describe, expect, it } from 'vitest';
import { MedicalSwitches, togglesFrom } from './medical-switches';

/** Just enough of Prisma for the switches: one stored "medical" setting. */
function fakePrisma(value: unknown) {
  const state = { value, reads: 0 };
  const prisma = {
    setting: {
      findUnique: async () => {
        state.reads += 1;
        return state.value === undefined ? null : { key: 'medical', value: state.value };
      },
    },
  } as unknown as PrismaClient;
  return { prisma, state };
}

describe('MedicalSwitches (D-063)', () => {
  it('treats anything not explicitly false as on', () => {
    expect(togglesFrom(undefined)).toEqual({
      'nlm-ctss': true,
      'nlm-rxnav': true,
      openfda: true,
      medlineplus: true,
    });
    expect(togglesFrom({ enabled: { openfda: false, medlineplus: 'no' } }).openfda).toBe(false);
    expect(togglesFrom({ enabled: { openfda: false, medlineplus: 'no' } }).medlineplus).toBe(true);
  });

  it('loads from the DB, applies saves at once and reloads after the TTL', async () => {
    const { prisma, state } = fakePrisma({ enabled: { openfda: false } });
    // ttl -1: always stale, so every call kicks off a background reload
    const switches = new MedicalSwitches(prisma, -1);
    expect(switches.isEnabled('openfda')).toBe(true); // not loaded yet: everything on
    await switches.load();
    expect(switches.isEnabled('openfda')).toBe(false);

    switches.set({ ...switches.current(), openfda: true, medlineplus: false });
    expect(switches.isEnabled('medlineplus')).toBe(false); // answers from memory at once
    await new Promise((r) => setTimeout(r, 0));

    // another process changed the row: the next call reloads it in the background
    state.value = { enabled: { 'nlm-ctss': false } };
    const before = state.reads;
    switches.isEnabled('nlm-ctss');
    await new Promise((r) => setTimeout(r, 0));
    expect(state.reads).toBeGreaterThan(before);
    expect(switches.current()['nlm-ctss']).toBe(false);
    expect(switches.current().medlineplus).toBe(true);
  });

  it('keeps the last state when a reload fails', async () => {
    const prisma = {
      setting: {
        findUnique: async () => {
          throw new Error('db down');
        },
      },
    } as unknown as PrismaClient;
    const switches = new MedicalSwitches(prisma, -1);
    switches.set({ 'nlm-ctss': true, 'nlm-rxnav': false, openfda: true, medlineplus: true });
    expect(switches.isEnabled('nlm-rxnav')).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(switches.isEnabled('nlm-rxnav')).toBe(false);
  });
});
