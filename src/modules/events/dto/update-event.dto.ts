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
    @IsObject()
    routeGeojson?: any;
}
