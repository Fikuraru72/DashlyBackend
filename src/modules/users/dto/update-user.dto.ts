import { IsObject, IsOptional, IsString, IsNumber, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { HealthInfoDto } from '../auth/dto/register.dto';

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => HealthInfoDto)
  healthInfo?: HealthInfoDto;

  @IsOptional()
  @IsNumber()
  roleId?: number;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsString()
  avatar?: string;
}
