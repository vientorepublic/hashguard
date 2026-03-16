import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateChallengeDto {
  @ApiPropertyOptional({
    description: 'Free-form context label (e.g. "login", "signup", "comment")',
    maxLength: 128,
    example: 'login',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  context?: string;
}
