import { IsIn, IsString } from 'class-validator';

export class UpdateEventStatusDto {
    @IsString()
    @IsIn(['IDLE', 'LIVE', 'FINISHED'])
    status!: string;
}
