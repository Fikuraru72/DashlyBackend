import { IsObject, IsOptional, IsString } from 'class-validator';

export class UpdateUserDto {
    @IsOptional()
    @IsString()
    phone?: string;

    @IsOptional()
    @IsObject()
    healthInfo?: Record<string, unknown>;
}
