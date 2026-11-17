import { type Mock } from 'vitest';
import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { GlobalExceptionsFilter } from '../src/common/filters/global-exceptions.filter';
import { PowErrors } from '../src/common/exceptions/pow.exceptions';

interface MockResponse {
  setHeader: Mock;
  status: Mock;
  json: Mock;
}

function runCatch(
  exception: unknown,
  { url = '/v1/pow/challenges' } = {},
): { status: number; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  let capturedStatus = 0;
  const response: MockResponse = {
    setHeader: vi.fn((name: string, value: string) => {
      headers[name] = value;
    }),
    status: vi.fn((code: number) => {
      capturedStatus = code;
      return response;
    }),
    json: vi.fn(),
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ url }),
    }),
  } as unknown as ArgumentsHost;

  new GlobalExceptionsFilter().catch(exception, host);

  return { status: capturedStatus, headers };
}

describe('GlobalExceptionsFilter Retry-After', () => {
  it('uses the exception-provided retryAfter on a 429', () => {
    const exception = new HttpException(
      {
        code: 'POW_ADAPTIVE_RATE_LIMITED',
        message: 'slow down',
        retryAfter: 45,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
    const { status, headers } = runCatch(exception);
    expect(status).toBe(429);
    expect(headers['Retry-After']).toBe('45');
  });

  it('falls back to 60s when a 429 carries no retryAfter (PowErrors 429s)', () => {
    const { status, headers } = runCatch(PowErrors.tooManyFailures());
    expect(status).toBe(429);
    expect(headers['Retry-After']).toBe('60');
  });

  it('ignores a non-positive retryAfter and falls back to 60s', () => {
    const exception = new HttpException(
      { code: 'X', message: 'm', retryAfter: 0 },
      HttpStatus.TOO_MANY_REQUESTS,
    );
    const { headers } = runCatch(exception);
    expect(headers['Retry-After']).toBe('60');
  });

  it('does not set Retry-After for non-429 responses', () => {
    const { status, headers } = runCatch(PowErrors.invalidProof());
    expect(status).toBe(400);
    expect(headers['Retry-After']).toBeUndefined();
  });
});
