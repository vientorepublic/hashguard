export default () => ({
  app: {
    port: parseInt(process.env.PORT ?? '3000', 10),
    nodeEnv: process.env.NODE_ENV ?? 'development',
    trustedProxy: process.env.TRUSTED_PROXY ?? 'cloudflare',
    corsOrigins: process.env.CORS_ORIGINS ?? '*',
  },
  redis: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB ?? '0', 10),
    keyPrefix: process.env.REDIS_KEY_PREFIX ?? 'hg:',
  },
  pow: {
    challengeTtlSeconds: parseInt(
      process.env.POW_CHALLENGE_TTL_SECONDS ?? '120',
      10,
    ),
    proofTokenTtlSeconds: parseInt(
      process.env.POW_PROOF_TOKEN_TTL_SECONDS ?? '300',
      10,
    ),
    tokenSecret:
      process.env.POW_TOKEN_SECRET ??
      'CHANGE_ME_IN_PRODUCTION_use_32_plus_random_bytes',
    baseDifficultyBits: parseInt(
      process.env.POW_BASE_DIFFICULTY_BITS ?? '20',
      10,
    ),
    maxDifficultyBits: parseInt(
      process.env.POW_MAX_DIFFICULTY_BITS ?? '32',
      10,
    ),
    minSolveTimeMs: parseInt(process.env.POW_MIN_SOLVE_TIME_MS ?? '50', 10),
    maxFailuresPerChallenge: parseInt(
      process.env.POW_MAX_FAILURES_PER_CHALLENGE ?? '10',
      10,
    ),
    maxChallengeRpm: parseInt(process.env.POW_MAX_CHALLENGE_RPM ?? '60', 10),
    rateTiersJson:
      process.env.POW_RATE_TIERS_JSON ??
      '[{"minRpm":30,"extraBits":6},{"minRpm":20,"extraBits":4},{"minRpm":10,"extraBits":2},{"minRpm":5,"extraBits":1},{"minRpm":0,"extraBits":0}]',
  },
  metrics: {
    maxDifficultyDistributionKeys: parseInt(
      process.env.METRICS_MAX_DIFFICULTY_DISTRIBUTION_KEYS ?? '64',
      10,
    ),
  },
});
