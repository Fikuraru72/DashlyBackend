import { IsIn, IsString } from 'class-validator';

export class UpdateEventStatusDto {
  @IsString()
  @IsIn([
    'DRAFT',
    'REGISTRATION_OPEN',
    'REGISTRATION_CLOSED',
    'READY',
    'LIVE',
    'FINISHED',
    'CANCELLED',
    'IDLE',
    'START',
  ])
  status!: string;
}
