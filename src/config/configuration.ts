export default () => ({
  app: {
    port: parseInt(process.env.PORT ?? '3000', 10),
    nodeEnv: process.env.NODE_ENV ?? 'development',
    trustedProxy: process.env.TRUSTED_PROXY ?? 'none',
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
    riskKeySecret: process.env.POW_RISK_KEY_SECRET,
    softLimitUnits: parseInt(process.env.POW_SOFT_LIMIT_UNITS ?? '30', 10),
    hardLimitUnits: parseInt(process.env.POW_HARD_LIMIT_UNITS ?? '120', 10),
    burstSoftLimitUnits: parseInt(
      process.env.POW_BURST_SOFT_LIMIT_UNITS ?? '5',
      10,
    ),
    burstHardLimitUnits: parseInt(
      process.env.POW_BURST_HARD_LIMIT_UNITS ?? '30',
      10,
    ),
    challengeRiskThreshold: parseInt(
      process.env.POW_CHALLENGE_RISK_THRESHOLD ?? '20',
      10,
    ),
    maxVerificationRpm: parseInt(
      process.env.POW_MAX_VERIFICATION_RPM ?? '120',
      10,
    ),
    contextCostsJson:
      process.env.POW_CONTEXT_COSTS_JSON ??
      '{"search":3,"query":5,"export":20}',

    challengeTtlSeconds: parseInt(
      process.env.POW_CHALLENGE_TTL_SECONDS ?? '300',
      10,
    ),
    proofTokenTtlSeconds: parseInt(
      process.env.POW_PROOF_TOKEN_TTL_SECONDS ?? '300',
      10,
    ),
    tokenPrivateKeyPem: process.env.POW_TOKEN_PRIVATE_KEY_PEM,
    tokenPrivateKeyBase64: process.env.POW_TOKEN_PRIVATE_KEY_BASE64,
    baseDifficultyBits: parseInt(
      process.env.POW_BASE_DIFFICULTY_BITS ?? '16',
      10,
    ),
    maxDifficultyBits: parseInt(
      process.env.POW_MAX_DIFFICULTY_BITS ?? '24',
      10,
    ),
    minSolveTimeMs: parseInt(process.env.POW_MIN_SOLVE_TIME_MS ?? '0', 10),
    maxFailuresPerChallenge: parseInt(
      process.env.POW_MAX_FAILURES_PER_CHALLENGE ?? '5',
      10,
    ),
    maxChallengeRpm: parseInt(process.env.POW_MAX_CHALLENGE_RPM ?? '60', 10),
    rateTiersJson:
      process.env.POW_RATE_TIERS_JSON ??
      '[{"minRpm":30,"extraBits":6},{"minRpm":20,"extraBits":3},{"minRpm":10,"extraBits":2},{"minRpm":5,"extraBits":1},{"minRpm":0,"extraBits":0}]',
  },
  metrics: {
    maxDifficultyDistributionKeys: parseInt(
      process.env.METRICS_MAX_DIFFICULTY_DISTRIBUTION_KEYS ?? '64',
      10,
    ),
  },
});
