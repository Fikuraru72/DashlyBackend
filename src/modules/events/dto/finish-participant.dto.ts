import { IsNumber, IsOptional } from 'class-validator';

export class FinishParticipantDto {
  @IsOptional()
  @IsNumber()
  durationSeconds?: number;

  @IsOptional()
  @IsNumber()
  totalDistanceMeters?: number;

  @IsOptional()
  @IsNumber()
  avgSpeedKmh?: number;

  @IsOptional()
  @IsNumber()
  maxSpeedKmh?: number;

  @IsOptional()
  @IsNumber()
  elevationGainMeters?: number;
}
