import { Module } from '@nestjs/common';
import { AnalysisService } from './analysis.service';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [RedisModule],
  providers: [AnalysisService],
  exports: [AnalysisService]
})
export class AnalysisModule { }
