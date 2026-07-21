import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VectorDbConfigEntity } from './vector-db-config.entity';
import { VectorCollectionEntity } from './vector-collection.entity';
import { VectorDbService } from './vector-db.service';
import { VectorDbController } from './vector-db.controller';
import { VectorStoreProviderService } from './vector-store-provider.service';
import { EmbedModule } from '../embed/embed.module';
import { CustomToolsModule } from '../custom-tools/custom-tools.module';
import { InternalVectorController } from './internal-vector.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([VectorDbConfigEntity, VectorCollectionEntity]),
    forwardRef(() => EmbedModule),        // breaks the VectorDb ↔ Embed cycle
    forwardRef(() => CustomToolsModule),  // breaks the VectorDb ↔ CustomTools cycle (auto search tool)
  ],
  providers: [VectorDbService, VectorStoreProviderService],
  controllers: [VectorDbController, InternalVectorController],
  exports: [VectorDbService, VectorStoreProviderService],
})
export class VectorDbModule {}
