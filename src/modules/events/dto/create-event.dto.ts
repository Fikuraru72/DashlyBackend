import { IsNotEmpty, IsNumber, IsString } from 'class-validator';

export class CreateEventDto {
    @IsString()
    @IsNotEmpty()
    name!: string;

    @IsString()
    description!: string;

    @IsNumber()
    maxParticipants!: number;
}
