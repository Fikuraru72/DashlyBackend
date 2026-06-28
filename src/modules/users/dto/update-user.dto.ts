import { IsObject, IsOptional, IsString, IsNumber } from 'class-validator';

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsObject()
  healthInfo?: Record<string, unknown>;

  @IsOptional()
  @IsNumber()
  roleId?: number;
}
