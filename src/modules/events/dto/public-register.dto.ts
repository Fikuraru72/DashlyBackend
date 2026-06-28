import { IsEmail, IsNotEmpty, IsString, IsOptional } from 'class-validator';

export class PublicRegisterDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsEmail()
  @IsNotEmpty()
  email!: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}
