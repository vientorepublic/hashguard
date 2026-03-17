import { HttpException, HttpStatus } from '@nestjs/common';

function powError(
  status: HttpStatus,
  code: string,
  message: string,
): HttpException {
  return new HttpException({ code, message }, status);
}

export const PowErrors = {
  challengeNotFound: () =>
    powError(
      HttpStatus.NOT_FOUND,
      'POW_CHALLENGE_NOT_FOUND',
      'Challenge not found, expired, or already used',
    ),

  challengeIpMismatch: () =>
    powError(
      HttpStatus.FORBIDDEN,
      'POW_CHALLENGE_IP_MISMATCH',
      'Request IP does not match the challenge IP',
    ),

  invalidProof: () =>
    powError(
      HttpStatus.BAD_REQUEST,
      'POW_INVALID_PROOF',
      'Nonce does not satisfy the required target',
    ),

  tooManyFailures: () =>
    powError(
      HttpStatus.TOO_MANY_REQUESTS,
      'POW_TOO_MANY_FAILURES',
      'Too many failed attempts for this challenge',
    ),

  solveTooFast: () =>
    powError(
      HttpStatus.BAD_REQUEST,
      'POW_SOLVE_TOO_FAST',
      'Reported solve time is suspiciously fast',
    ),

  tokenInvalid: () =>
    powError(
      HttpStatus.UNAUTHORIZED,
      'POW_TOKEN_INVALID',
      'Proof token is invalid or malformed',
    ),

  tokenExpired: () =>
    powError(
      HttpStatus.UNAUTHORIZED,
      'POW_TOKEN_EXPIRED',
      'Proof token has expired',
    ),

  tokenAlreadyUsed: () =>
    powError(
      HttpStatus.CONFLICT,
      'POW_TOKEN_ALREADY_USED',
      'Proof token has already been consumed',
    ),

  tokenStateUnavailable: () =>
    powError(
      HttpStatus.SERVICE_UNAVAILABLE,
      'POW_TOKEN_STATE_UNAVAILABLE',
      'Token state could not be verified safely',
    ),
} as const;
