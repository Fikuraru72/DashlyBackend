import { IsIn, IsString } from 'class-validator';

export class UpdateEventStatusDto {
    @IsString()
    @IsIn(['IDLE', 'START', 'FINISHED'])
    status!: string;
}
