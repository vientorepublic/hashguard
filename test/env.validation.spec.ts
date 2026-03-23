import { validateEnvironment } from '../src/config/env.validation';

describe('validateEnvironment', () => {
  it('should pass with an empty env object (defaults are used)', () => {
    expect(() => validateEnvironment({})).not.toThrow();
  });

  it('should pass with valid explicit PoW settings', () => {
    const env = {
      POW_BASE_DIFFICULTY_BITS: '21',
      POW_MAX_DIFFICULTY_BITS: '26',
      POW_CHALLENGE_TTL_SECONDS: '120',
      POW_PROOF_TOKEN_TTL_SECONDS: '300',
      POW_RATE_TIERS_JSON: JSON.stringify([
        { minRpm: 30, extraBits: 6 },
        { minRpm: 0, extraBits: 0 },
      ]),
      TRUSTED_PROXY: 'cloudflare',
    };

    expect(() => validateEnvironment(env)).not.toThrow();
  });

  it('should fail when base difficulty exceeds max difficulty', () => {
    expect(() =>
      validateEnvironment({
        POW_BASE_DIFFICULTY_BITS: '27',
        POW_MAX_DIFFICULTY_BITS: '26',
      }),
    ).toThrow('POW_BASE_DIFFICULTY_BITS must be <= POW_MAX_DIFFICULTY_BITS');
  });

  it('should fail for out-of-range difficulty bits', () => {
    expect(() =>
      validateEnvironment({
        POW_BASE_DIFFICULTY_BITS: '0',
      }),
    ).toThrow('POW_BASE_DIFFICULTY_BITS must be >= 1');

    expect(() =>
      validateEnvironment({
        POW_MAX_DIFFICULTY_BITS: '256',
      }),
    ).toThrow('POW_MAX_DIFFICULTY_BITS must be <= 255');
  });

  it('should fail when rate tiers JSON is malformed', () => {
    expect(() =>
      validateEnvironment({
        POW_RATE_TIERS_JSON: '{not-json}',
      }),
    ).toThrow('POW_RATE_TIERS_JSON must be valid JSON');
  });

  it('should fail when rate tiers JSON misses base minRpm=0 tier', () => {
    expect(() =>
      validateEnvironment({
        POW_RATE_TIERS_JSON: JSON.stringify([{ minRpm: 10, extraBits: 2 }]),
      }),
    ).toThrow('POW_RATE_TIERS_JSON must include a tier with minRpm=0');
  });

  it('should fail when trusted proxy mode is invalid', () => {
    expect(() =>
      validateEnvironment({
        TRUSTED_PROXY: 'invalid-value',
      }),
    ).toThrow(
      'TRUSTED_PROXY must be one of: none, cloudflare, x-forwarded-for',
    );
  });

  it('should fail when challenge ttl exceeds proof token ttl', () => {
    expect(() =>
      validateEnvironment({
        POW_CHALLENGE_TTL_SECONDS: '301',
        POW_PROOF_TOKEN_TTL_SECONDS: '300',
      }),
    ).toThrow(
      'POW_CHALLENGE_TTL_SECONDS should not exceed POW_PROOF_TOKEN_TTL_SECONDS',
    );
  });

  it('should fail when both private key env vars are set', () => {
    expect(() =>
      validateEnvironment({
        POW_TOKEN_PRIVATE_KEY_PEM: '-----BEGIN PRIVATE KEY-----',
        POW_TOKEN_PRIVATE_KEY_BASE64: 'ZmFrZQ==',
      }),
    ).toThrow(
      'Only one of POW_TOKEN_PRIVATE_KEY_PEM or POW_TOKEN_PRIVATE_KEY_BASE64 may be set',
    );
  });
});
