import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ClientMetricsDto {
  @ApiPropertyOptional({
    description: 'Time (ms) the client spent computing the nonce',
    example: 850,
  })
  @IsOptional()
  @IsInt({ message: 'solveTimeMs must be an integer' })
  @Min(0, { message: 'solveTimeMs must be >= 0' })
  @Max(3_600_000, { message: 'solveTimeMs must be <= 3600000 (1 hour)' })
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
