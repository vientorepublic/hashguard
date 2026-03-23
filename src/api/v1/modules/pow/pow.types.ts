/** Challenge record stored in Redis. */
export interface StoredChallenge {
  id: string;
  seed: string; // 32-byte random hex
  targetHex: string; // 64-char lowercase hex (256-bit target)
  difficultyBits: number;
  algorithm: 'sha256';
  clientIp: string;
  context: string;
  issuedAt: number; // Unix ms
  expiresAt: number; // Unix ms
}

/** Decoded proof-token payload. */
export interface ProofTokenPayload {
  jti: string; // unique token ID (UUID)
  sub: string; // client IP
  context: string; // context string from challenge
  iat: number; // issued at (Unix seconds)
  exp: number; // expires at (Unix seconds)
}

/** Public JWK clients can use to verify proof-token signatures statelessly. */
export interface ProofTokenVerificationKey {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  use: 'sig';
  alg: 'ES256';
  kid: string;
}
