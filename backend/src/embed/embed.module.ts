import { Module, forwardRef } from '@nestjs/common';
import { EmbedService } from './embed.service';
import { EmbedIngestQueueService } from './embed-ingest.queue';
import { EmbedController } from './embed.controller';
import { InternalEmbedController } from './internal-embed.controller';
import { EmbeddingProviderService } from './embedding.provider.service';
import { FilesModule } from '../files/files.module';
import { AppConfigModule } from '../app-config/app-config.module';
import { VectorDbModule } from '../vector-db/vector-db.module';
import { ProjectsModule } from '../projects/projects.module';
import { DataSourcesModule } from '../datasources/datasources.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    FilesModule,
    forwardRef(() => AppConfigModule),  // forwardRef: breaks the circular dependency
    VectorDbModule,
    ProjectsModule,
    DataSourcesModule,   // ingestion of files living on a DataSource (network share)
    NotificationsModule, // end-of-indexing notification (asynchronous queue)
  ],
  providers: [EmbeddingProviderService, EmbedService, EmbedIngestQueueService],
  controllers: [EmbedController, InternalEmbedController],
  exports: [EmbeddingProviderService, EmbedService],
})
export class EmbedModule {}
