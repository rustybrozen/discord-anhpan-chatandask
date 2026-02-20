import { IsNotEmpty, IsString, IsOptional } from 'class-validator';

export class CreateMemoryDto {
  @IsString()
  @IsNotEmpty()
  message: string;

  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsString()
  @IsOptional()
  topic?: string;
}
