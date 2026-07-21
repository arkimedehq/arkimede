import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserMemory } from './user-memory.entity';
import { Chat } from '../chats/chats.entity';
import { Message } from '../messages/messages.entity';
import { User } from '../users/users.entity';
import { UserMemoryService } from './user-memory.service';
import { MemoryEvolutionService } from './memory-evolution.service';
import { UserMemoryController } from './user-memory.controller';
import { AppConfigModule } from '../app-config/app-config.module';
import { EmbedModule } from '../embed/embed.module';
import { VectorDbModule } from '../vector-db/vector-db.module';
import { TeamsModule } from '../teams/teams.module';
import { ChatsModule } from '../chats/chats.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserMemory, Chat, Message, User]),
    AppConfigModule,
    EmbedModule,     // embeddings for the hybrid retrieval (F2)
    VectorDbModule,  // vector leg of the hybrid retrieval (F2)
    TeamsModule,     // membership checks for shared notes (F4)
    ChatsModule,     // chat-access check for on-demand extraction (M4/M5)
  ],
  providers: [UserMemoryService, MemoryEvolutionService],
  controllers: [UserMemoryController],
  exports: [UserMemoryService],
})
export class UserMemoryModule {}
