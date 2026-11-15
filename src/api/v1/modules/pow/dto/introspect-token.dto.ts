import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsIP,
  MaxLength,
} from 'class-validator';

export class IntrospectTokenDto {
  @ApiProperty({
    description: 'Proof token issued after successful PoW verification',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  proofToken: string;

  @ApiPropertyOptional({
    description:
      'Expected context supplied by the resource backend, checked before consumption',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  expectedContext?: string;

  @ApiPropertyOptional({
    description:
      'Original client IP supplied by the resource backend, checked before consumption',
  })
  @IsOptional()
  @IsIP()
  expectedSubject?: string;

  @ApiPropertyOptional({
    description:
      'When true (default), the token is consumed on successful verification (one-use policy). ' +
      'Set to false for read-only inspection.',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  consume?: boolean;
}
