import { IsNotEmpty, IsString, Length } from 'class-validator';

export class RedeemTokenDto {
  @IsString()
  @IsNotEmpty()
  @Length(6, 6, { message: 'Token code must be exactly 6 characters' })
  code!: string;
}
