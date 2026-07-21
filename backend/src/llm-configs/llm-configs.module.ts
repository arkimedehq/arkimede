import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LlmConfigEntity } from './llm-config.entity';
import { LlmConfigsService } from './llm-configs.service';
import { LlmConfigsController } from './llm-configs.controller';
import { UsageModule } from '../usage/usage.module';

@Module({
  // UsageModule: LlmMetricsService — serving metrics handler attached to every built model.
  imports: [TypeOrmModule.forFeature([LlmConfigEntity]), UsageModule],
  providers: [LlmConfigsService],
  controllers: [LlmConfigsController],
  exports: [LlmConfigsService],
})
export class LlmConfigsModule {}
