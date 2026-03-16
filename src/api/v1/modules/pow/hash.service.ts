import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';

@Injectable()
export class HashService {
  /**
   * Computes the 256-bit PoW target for a given difficulty.
   *
   * A target is valid when: SHA-256(preimage) ≤ target
   * (lexicographic comparison works because both strings are the same
   *  length lowercase hex, i.e. 64 chars).
   *
   * difficultyBits N means the top N bits of the hash must be zero.
   * Example: N=20 → target = "00000fffff…ff" (first 20 bits are 0).
   */
  computeTarget(difficultyBits: number): string {
    if (difficultyBits < 1 || difficultyBits > 255) {
      throw new RangeError(
        `difficultyBits must be between 1 and 255, got ${difficultyBits}`,
      );
    }

    const leadingZeroBytes = Math.floor(difficultyBits / 8);
    const remainingBits = difficultyBits % 8;

    const bytes = new Uint8Array(32); // default all zeros
    const filledFrom = leadingZeroBytes + (remainingBits > 0 ? 1 : 0);
    bytes.fill(0xff, filledFrom);

    if (remainingBits > 0) {
      // e.g. remainingBits=4 → top 4 bits zero → byte value = 0x0f
      bytes[leadingZeroBytes] = 0xff >> remainingBits;
    }

    return Buffer.from(bytes).toString('hex');
  }

  /**
   * Verifies that SHA-256(challengeId:seed:nonce) ≤ targetHex.
   */
  verifyProof(
    challengeId: string,
    seed: string,
    nonce: string,
    targetHex: string,
  ): boolean {
    const preimage = `${challengeId}:${seed}:${nonce}`;
    const hash = crypto
      .createHash('sha256')
      .update(preimage, 'utf8')
      .digest('hex');
    return hash <= targetHex;
  }

  /**
   * Returns the SHA-256 hash of the given preimage as a hex string.
   * Useful for ad-hoc computations and tests.
   */
  sha256hex(preimage: string): string {
    return crypto.createHash('sha256').update(preimage, 'utf8').digest('hex');
  }
}
