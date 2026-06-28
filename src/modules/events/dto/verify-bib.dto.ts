import { IsNotEmpty, IsString } from 'class-validator';

export class VerifyBibDto {
  @IsString()
  @IsNotEmpty()
  bibNumber!: string;
}
