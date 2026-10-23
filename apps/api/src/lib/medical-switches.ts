import type { PrismaClient } from '@datascribe/db';
import { UPSTREAMS, type Upstream } from '@datascribe/medical-data';

export const MEDICAL_SETTING = 'medical';

export type MedicalToggles = Record<Upstream, boolean>;

export const ALL_ENABLED: MedicalToggles = Object.fromEntries(
  UPSTREAMS.map((u) => [u, true]),
) as MedicalToggles;

export function togglesFrom(value: unknown): MedicalToggles {
  const enabled = ((value ?? {}) as { enabled?: Record<string, unknown> }).enabled ?? {};
  return Object.fromEntries(UPSTREAMS.map((u) => [u, enabled[u] !== false])) as MedicalToggles;
}

/**
 * Admin on/off switch per medical upstream (§8.4), read synchronously by the adapters on every
 * call. Saving in the admin console updates this process at once; other processes (a second API
 * instance, the worker) pick the change up within `ttlMs` (D-063), no restart needed.
 */
export class MedicalSwitches {
  private toggles: MedicalToggles = { ...ALL_ENABLED };
  private loadedAt = 0;
  private loading: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly ttlMs = 30_000,
  ) {}

  async load(): Promise<MedicalToggles> {
    const row = await this.prisma.setting.findUnique({ where: { key: MEDICAL_SETTING } });
    this.set(togglesFrom(row?.value));
    return this.current();
  }

  set(toggles: MedicalToggles) {
    this.toggles = { ...toggles };
    this.loadedAt = Date.now();
  }

  current(): MedicalToggles {
    return { ...this.toggles };
  }

  isEnabled = (upstream: Upstream): boolean => {
    if (Date.now() - this.loadedAt > this.ttlMs && !this.loading) {
      // refresh in the background; this call answers from the last known state
      this.loading = this.load()
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
          this.loading = null;
        });
    }
    return this.toggles[upstream] !== false;
  };
}
