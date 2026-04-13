import { IsEmail, IsNotEmpty, IsObject, IsOptional, IsString, MinLength } from 'class-validator';

export class RegisterDto {
    @IsEmail()
    email!: string;

    @IsString()
    @MinLength(6)
    password!: string;

    @IsString()
    @IsNotEmpty()
    name!: string;

    @IsOptional()
    @IsString()
    phone?: string;

    @IsOptional()
    @IsObject()
    healthInfo?: Record<string, unknown>;
}

