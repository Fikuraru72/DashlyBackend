import { Module } from '@nestjs/common';
import { TokensController } from './tokens.controller';
import { TokensService } from './tokens.service';
import { DatabaseModule } from '../../db/database.module';

@Module({
  imports: [DatabaseModule],
  controllers: [TokensController],
  providers: [TokensService],
})
export class TokensModule {}
