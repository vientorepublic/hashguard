import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ClientMetricsDto {
  @ApiPropertyOptional({
    description: 'Time (ms) the client spent computing the nonce',
    example: 850,
  })
  @IsOptional()
  solveTimeMs?: number;
}

export class VerifyChallengeDto {
  @ApiProperty({
    description: 'Challenge ID returned by POST /challenges',
    format: 'uuid',
  })
  @IsUUID()
  @IsNotEmpty()
  challengeId: string;

  @ApiProperty({
    description:
      'Nonce value that, combined with the challenge seed, produces a hash ≤ target',
    maxLength: 128,
    example: '4829371',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  @Matches(/^[a-zA-Z0-9_-]+$/, {
    message: 'nonce must be alphanumeric (a-z, A-Z, 0-9, _, -)',
  })
  nonce: string;

  @ApiPropertyOptional({ type: ClientMetricsDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ClientMetricsDto)
  clientMetrics?: ClientMetricsDto;
}
