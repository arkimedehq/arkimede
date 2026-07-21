import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustomTool } from './custom-tool.entity';
import { ToolSecret } from './tool-secret.entity';
import { CustomToolsService } from './custom-tools.service';
import { CustomToolsController } from './custom-tools.controller';
import { DataSourcesModule } from '../datasources/datasources.module';
import { EmbedModule } from '../embed/embed.module';
import { VectorDbModule } from '../vector-db/vector-db.module';
import { AppConfigModule } from '../app-config/app-config.module';
import { TeamsModule } from '../teams/teams.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([CustomTool, ToolSecret]),
    DataSourcesModule,
    // forwardRef on both: VectorDbModule now imports CustomToolsModule (auto
    // search tool), so Embed → VectorDb → CustomTools → Embed is a JS module
    // cycle and these classes can be undefined at decorator-evaluation time.
    forwardRef(() => EmbedModule),      // provides EmbeddingProviderService
    forwardRef(() => VectorDbModule),   // provides VectorStoreProviderService
    AppConfigModule,   // provides AppConfigService (API key for the Prompt executor)
    TeamsModule,       // provides TeamsService (team scoping)
  ],
  providers: [CustomToolsService],
  controllers: [CustomToolsController],
  exports: [CustomToolsService],
})
export class CustomToolsModule {}
