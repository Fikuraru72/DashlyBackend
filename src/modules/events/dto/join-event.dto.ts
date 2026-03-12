import { IsNotEmpty, IsString } from 'class-validator';

export class JoinEventDto {
    @IsString()
    @IsNotEmpty()
    token!: string;
}
