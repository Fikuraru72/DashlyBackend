import { IsNumber, IsString, IsOptional, IsObject, IsDateString, IsIn } from 'class-validator';

export class UpdateEventDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsNumber()
  maxParticipants?: number;

  @IsOptional()
  @IsDateString()
  dateEvent?: string;

  @IsOptional()
  @IsString()
  @IsIn(['RUNNING', 'CYCLING'])
  category?: string;

  @IsOptional()
  @IsDateString()
  startTime?: string;

  @IsOptional()
  @IsDateString()
  endTime?: string;

  @IsOptional()
  @IsNumber()
  monitoringStartOffset?: number;

  @IsOptional()
  @IsNumber()
  monitoringEndOffset?: number;

  @IsOptional()
  @IsNumber()
  totalDistanceMeters?: number;

  @IsOptional()
  @IsNumber()
  totalElevationMeters?: number;

  @IsOptional()
  @IsObject()
  routeGeojson?: any;

  @IsOptional()
  @IsDateString()
  registrationOpen?: string;

  @IsOptional()
  @IsDateString()
  registrationClose?: string;

  @IsOptional()
  @IsString()
  locationName?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  province?: string;

  @IsOptional()
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @IsNumber()
  longitude?: number;

  @IsOptional()
  @IsString()
  bannerImage?: string;
}
