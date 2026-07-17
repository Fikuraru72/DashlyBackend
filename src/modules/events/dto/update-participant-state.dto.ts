import { IsIn, IsString } from 'class-validator';

export class UpdateParticipantStateDto {
  @IsString()
  @IsIn(['REGISTERED', 'CONFIRMED', 'TRACKING', 'FROZEN', 'FINISHED'])
  state!: string;
}
