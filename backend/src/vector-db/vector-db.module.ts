// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

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
import { ReembedService } from './reembed.service';
import { EmbeddingModelCheck } from './embedding-model.check';
import { UserMemory } from '../user-memory/user-memory.entity';
import { Feedback } from '../feedback/feedback.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([VectorDbConfigEntity, VectorCollectionEntity, UserMemory, Feedback]),
    forwardRef(() => EmbedModule),        // breaks the VectorDb ↔ Embed cycle
    forwardRef(() => CustomToolsModule),  // breaks the VectorDb ↔ CustomTools cycle (auto search tool)
  ],
  providers: [VectorDbService, VectorStoreProviderService, ReembedService, EmbeddingModelCheck],
  controllers: [VectorDbController, InternalVectorController],
  exports: [VectorDbService, VectorStoreProviderService],
})
export class VectorDbModule {}
