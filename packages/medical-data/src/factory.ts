import type { Attribution } from './attribution';
import { DEFAULT_CACHE_TTL_MS, MemoryCacheStore, type CacheStore } from './resilience/cache';
import type { BreakerConfig } from './resilience/breaker';
import { ProviderClient, type FetchLike, type MedicalLogger } from './resilience/provider-client';
import type { RateLimitConfig } from './resilience/rate-limit';
import type { RetryOptions } from './resilience/retry';
import { UsageTracker, type ProviderUsage } from './resilience/usage';
import { MedlinePlusConnect } from './providers/medlineplus';
import {
  MockConsumerHealthInfo,
  MockDiagnosisCoder,
  MockDrugInfo,
  MockMedicationNormalizer,
  MockOcrProvider,
  MockProcedureCoder,
  MockSummaryProvider,
} from './providers/mock';
import { NlmHcpcsCoder, NlmIcd10Coder, RxNormNormalizer } from './providers/nlm';
import { OpenFdaDrugInfo } from './providers/openfda';
import type {
  ConsumerHealthInfo,
  DiagnosisCoder,
  DrugInfoProvider,
  MedicationNormalizer,
  OcrProvider,
  ProcedureCoder,
  SummaryProvider,
} from './types';

export const MEDICAL_DATA_PROVIDERS = ['nlm', 'mock'] as const;
export type MedicalDataProviderKind = (typeof MEDICAL_DATA_PROVIDERS)[number];

/** Upstream services; each gets its own token bucket, breaker and usage counters. */
export const UPSTREAMS = ['nlm-ctss', 'nlm-rxnav', 'openfda', 'medlineplus'] as const;
export type Upstream = (typeof UPSTREAMS)[number];

/**
 * Defaults stay well under each provider's published limit (D-050..D-053), because every API
 * and worker process has its own bucket:
 * CTSS advises <= 25 req/s, RxNav allows 20 req/s per IP, openFDA 240/min (1,000/day without a
 * key), MedlinePlus Connect 100/min per IP.
 */
export const DEFAULT_RATE_LIMITS: Record<Upstream, RateLimitConfig> = {
  'nlm-ctss': { capacity: 10, refillPerSecond: 10 },
  'nlm-rxnav': { capacity: 10, refillPerSecond: 8 },
  openfda: { capacity: 10, refillPerSecond: 2 },
  medlineplus: { capacity: 10, refillPerSecond: 1.2 },
};

export interface MedicalDataConfig {
  provider?: MedicalDataProviderKind;
  openFdaApiKey?: string;
  cache?: CacheStore;
  cacheTtlMs?: number;
  rateLimits?: Partial<Record<Upstream, RateLimitConfig>>;
  timeoutMs?: number;
  retry?: Partial<RetryOptions>;
  breaker?: BreakerConfig;
  fetch?: FetchLike;
  logger?: MedicalLogger;
  usage?: UsageTracker;
  /** Admin toggle (§8.4). Read on every call, so a settings change applies without restart. */
  isEnabled?: (upstream: Upstream) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface MedicalData {
  provider: MedicalDataProviderKind;
  diagnosis: DiagnosisCoder & { attribution: Attribution };
  procedure: ProcedureCoder & { attribution: Attribution };
  medication: MedicationNormalizer & { attribution: Attribution };
  drugInfo: DrugInfoProvider & { attribution: Attribution };
  consumerHealth: ConsumerHealthInfo & { attribution: Attribution };
  /** Last-24h call counts and error rates per upstream, for the admin settings page (M2). */
  usageStats(windowMs?: number): ProviderUsage[];
}

export function createMedicalData(config: MedicalDataConfig = {}): MedicalData {
  const kind = config.provider ?? 'mock';
  const usage = config.usage ?? new UsageTracker(config.now);
  if (kind === 'mock') {
    return {
      provider: 'mock',
      diagnosis: new MockDiagnosisCoder(),
      procedure: new MockProcedureCoder(),
      medication: new MockMedicationNormalizer(),
      drugInfo: new MockDrugInfo(),
      consumerHealth: new MockConsumerHealthInfo(),
      usageStats: (windowMs) => usage.stats(windowMs, []),
    };
  }

  const cache = config.cache ?? new MemoryCacheStore(config.now);
  const fetchImpl: FetchLike = config.fetch ?? ((url, init) => fetch(url, init));
  const client = (upstream: Upstream) =>
    new ProviderClient({
      provider: upstream,
      fetch: fetchImpl,
      cache,
      usage,
      rateLimit: config.rateLimits?.[upstream] ?? DEFAULT_RATE_LIMITS[upstream],
      cacheTtlMs: config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
      timeoutMs: config.timeoutMs,
      retry: config.retry,
      breaker: config.breaker,
      logger: config.logger,
      isEnabled: config.isEnabled ? () => config.isEnabled!(upstream) : undefined,
      now: config.now,
      sleep: config.sleep,
    });
  const ctss = client('nlm-ctss');
  return {
    provider: 'nlm',
    diagnosis: new NlmIcd10Coder(ctss),
    procedure: new NlmHcpcsCoder(ctss),
    medication: new RxNormNormalizer(client('nlm-rxnav')),
    drugInfo: new OpenFdaDrugInfo(client('openfda'), config.openFdaApiKey || undefined),
    consumerHealth: new MedlinePlusConnect(client('medlineplus')),
    usageStats: (windowMs) => usage.stats(windowMs, [...UPSTREAMS]),
  };
}

/** Read MEDICAL_DATA_PROVIDER (default mock) and OPENFDA_API_KEY. Unknown values are an error. */
export function medicalDataConfigFromEnv(
  env: Record<string, string | undefined>,
): MedicalDataConfig {
  const provider = (env.MEDICAL_DATA_PROVIDER || 'mock') as MedicalDataProviderKind;
  if (!MEDICAL_DATA_PROVIDERS.includes(provider)) {
    throw new Error(`MEDICAL_DATA_PROVIDER must be one of ${MEDICAL_DATA_PROVIDERS.join(', ')}`);
  }
  return { provider, openFdaApiKey: env.OPENFDA_API_KEY || undefined };
}

export const OCR_PROVIDERS = ['tesseract', 'textract', 'mock'] as const;
export const SUMMARY_PROVIDERS = ['mock', 'anthropic', 'openai'] as const;

/** Only `mock` exists so far; tesseract/textract arrive with the pipeline (M5b). */
export function createOcrProvider(kind: (typeof OCR_PROVIDERS)[number] = 'mock'): OcrProvider {
  if (kind === 'mock') return new MockOcrProvider();
  throw new Error(`OCR_PROVIDER=${kind} is not implemented yet; use mock`);
}

/** Only `mock` exists so far; LLM providers need a BAA before production use (§8.3). */
export function createSummaryProvider(
  kind: (typeof SUMMARY_PROVIDERS)[number] = 'mock',
): SummaryProvider {
  if (kind === 'mock') return new MockSummaryProvider();
  throw new Error(`SUMMARY_PROVIDER=${kind} is not implemented yet; use mock`);
}
