import { IsNotEmpty, IsString, IsOptional } from 'class-validator';

export class GoogleLoginDto {
    @IsString()
    @IsNotEmpty()
    token!: string; // Real Google ID token, but for now we'll accept dummy

    @IsString()
    @IsOptional()
    email?: string;

    @IsString()
    @IsOptional()
    name?: string;

    @IsString()
    @IsOptional()
    googleId?: string;
    
    @IsString()
    @IsOptional()
    avatar?: string;
    
    @IsString()
    @IsOptional()
    role?: 'ADMIN' | 'RUNNER'; // For testing purposes
}
