type EnvMap = Record<string, unknown>;

interface RateTier {
  minRpm: number;
  extraBits: number;
}

const ALLOWED_TRUSTED_PROXY = new Set([
  'none',
  'cloudflare',
  'x-forwarded-for',
]);

function toScalarString(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') {
    return `${raw}`;
  }
  return undefined;
}

function parseOptionalInt(
  env: EnvMap,
  key: string,
  errors: string[],
  min?: number,
  max?: number,
): number | undefined {
  const raw = env[key];
  if (raw == null) return undefined;

  const rawString = toScalarString(raw);
  if (rawString == null || rawString === '') {
    errors.push(`${key} must be a numeric scalar value`);
    return undefined;
  }

  const value = Number.parseInt(rawString, 10);
  if (!Number.isInteger(value)) {
    errors.push(`${key} must be an integer`);
    return undefined;
  }

  if (min != null && value < min) {
    errors.push(`${key} must be >= ${min}`);
  }
  if (max != null && value > max) {
    errors.push(`${key} must be <= ${max}`);
  }

  return value;
}

function validateRateTiersJson(raw: string, errors: string[]): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    errors.push('POW_RATE_TIERS_JSON must be valid JSON');
    return;
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    errors.push('POW_RATE_TIERS_JSON must be a non-empty array');
    return;
  }

  const tiers = parsed as RateTier[];
  const hasBaseTier = tiers.some((tier) => tier.minRpm === 0);
  if (!hasBaseTier) {
    errors.push('POW_RATE_TIERS_JSON must include a tier with minRpm=0');
  }

  for (const tier of tiers) {
    if (!Number.isInteger(tier.minRpm) || tier.minRpm < 0) {
      errors.push(
        'Each POW_RATE_TIERS_JSON tier.minRpm must be a non-negative integer',
      );
      break;
    }
    if (!Number.isInteger(tier.extraBits) || tier.extraBits < 0) {
      errors.push(
        'Each POW_RATE_TIERS_JSON tier.extraBits must be a non-negative integer',
      );
      break;
    }
  }
}

export function validateEnvironment(env: EnvMap): EnvMap {
  const errors: string[] = [];

  const trustedProxy = env.TRUSTED_PROXY;
  if (trustedProxy != null) {
    const trustedProxyValue = toScalarString(trustedProxy);
    if (trustedProxyValue == null || trustedProxyValue === '') {
      errors.push(
        'TRUSTED_PROXY must be one of: none, cloudflare, x-forwarded-for',
      );
    } else if (!ALLOWED_TRUSTED_PROXY.has(trustedProxyValue)) {
      errors.push(
        'TRUSTED_PROXY must be one of: none, cloudflare, x-forwarded-for',
      );
    }
  }

  parseOptionalInt(env, 'PORT', errors, 1, 65535);
  parseOptionalInt(env, 'REDIS_PORT', errors, 1, 65535);
  parseOptionalInt(env, 'REDIS_DB', errors, 0);

  const challengeTtl = parseOptionalInt(
    env,
    'POW_CHALLENGE_TTL_SECONDS',
    errors,
    1,
  );
  const proofTokenTtl = parseOptionalInt(
    env,
    'POW_PROOF_TOKEN_TTL_SECONDS',
    errors,
    1,
  );
  const baseBits = parseOptionalInt(
    env,
    'POW_BASE_DIFFICULTY_BITS',
    errors,
    1,
    255,
  );
  const maxBits = parseOptionalInt(
    env,
    'POW_MAX_DIFFICULTY_BITS',
    errors,
    1,
    255,
  );
  parseOptionalInt(env, 'POW_MIN_SOLVE_TIME_MS', errors, 0);
  parseOptionalInt(env, 'POW_MAX_FAILURES_PER_CHALLENGE', errors, 1);
  parseOptionalInt(env, 'POW_MAX_CHALLENGE_RPM', errors, 1);
  parseOptionalInt(env, 'METRICS_MAX_DIFFICULTY_DISTRIBUTION_KEYS', errors, 1);

  if (
    baseBits != null &&
    maxBits != null &&
    Number.isInteger(baseBits) &&
    Number.isInteger(maxBits) &&
    baseBits > maxBits
  ) {
    errors.push('POW_BASE_DIFFICULTY_BITS must be <= POW_MAX_DIFFICULTY_BITS');
  }

  if (
    challengeTtl != null &&
    proofTokenTtl != null &&
    challengeTtl > proofTokenTtl
  ) {
    errors.push(
      'POW_CHALLENGE_TTL_SECONDS should not exceed POW_PROOF_TOKEN_TTL_SECONDS',
    );
  }

  const rateTiersRaw = env.POW_RATE_TIERS_JSON;
  if (rateTiersRaw != null) {
    const rateTiersRawString = toScalarString(rateTiersRaw);
    if (rateTiersRawString == null || rateTiersRawString === '') {
      errors.push('POW_RATE_TIERS_JSON must be valid JSON');
    } else {
      validateRateTiersJson(rateTiersRawString, errors);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Environment validation failed:\n- ${errors.join('\n- ')}`);
  }

  return env;
}
