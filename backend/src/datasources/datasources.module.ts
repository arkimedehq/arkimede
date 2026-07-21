import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSourceEntity } from './datasource.entity';
import { AppConfigEntity } from '../app-config/app-config.entity';
import { DataSourcesService } from './datasources.service';
import { SchemaEnrichmentService } from './schema-enrichment.service';
import { DataSourcesController } from './datasources.controller';
import { InternalDatasourcesController } from './internal-datasources.controller';
import { TeamsModule } from '../teams/teams.module';
import { LlmConfigsModule } from '../llm-configs/llm-configs.module';

@Module({
  imports:     [TypeOrmModule.forFeature([DataSourceEntity, AppConfigEntity]), TeamsModule, LlmConfigsModule],
  providers:   [DataSourcesService, SchemaEnrichmentService],
  controllers: [DataSourcesController, InternalDatasourcesController],
  exports:     [DataSourcesService],
})
export class DataSourcesModule {}
