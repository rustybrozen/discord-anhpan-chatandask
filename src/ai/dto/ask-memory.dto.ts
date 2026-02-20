import { IsNotEmpty, IsString } from 'class-validator';

export class AskMemoryDto {
  @IsString()
  @IsNotEmpty()
  message: string;

  @IsString()
  @IsNotEmpty()
  userId: string; 
}