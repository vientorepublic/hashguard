import { Controller, Get, Header, HttpCode, HttpStatus } from '@nestjs/common';
import type { ProofTokenJwks } from './pow.types';
import { TokenService } from './token.service';

interface JwksProvider {
  getJwks(): ProofTokenJwks;
}

@Controller('.well-known')
export class JwksController {
  private readonly jwksProvider: JwksProvider;

  constructor(tokenService: TokenService) {
    this.jwksProvider = tokenService;
  }

  @Get('jwks.json')
  @HttpCode(HttpStatus.OK)
  @Header('Content-Type', 'application/jwk-set+json; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=300, stale-while-revalidate=300')
  getJwks(): ProofTokenJwks {
    return this.jwksProvider.getJwks();
  }
}
