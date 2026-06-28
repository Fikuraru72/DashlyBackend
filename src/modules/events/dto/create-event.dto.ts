import {
  IsNotEmpty,
  IsNumber,
  IsString,
  IsOptional,
  IsObject,
  IsDateString,
  IsIn,
  IsInt,
} from 'class-validator';

export class CreateEventDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  description!: string;

  @IsNumber()
  maxParticipants!: number;

  @IsDateString()
  @IsNotEmpty()
  dateEvent!: string;

  @IsOptional()
  @IsString()
  @IsIn(['RUNNING', 'CYCLING'])
  category?: string;

  @IsDateString()
  @IsNotEmpty()
  startTime!: string;

  @IsDateString()
  @IsNotEmpty()
  endTime!: string;

  @IsOptional()
  @IsInt()
  monitoringStartOffset?: number;

  @IsOptional()
  @IsInt()
  monitoringEndOffset?: number;

  @IsOptional()
  @IsNumber()
  totalDistanceMeters?: number;

  @IsOptional()
  @IsNumber()
  totalElevationMeters?: number;

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

  @IsOptional()
  @IsObject()
  routeGeojson?: any;
}
