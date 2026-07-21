import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Message } from './messages.entity';
import { MessagesService } from './messages.service';
import { MessagesController } from './messages.controller';
import { ChatsModule } from '../chats/chats.module';
import { AgentModule } from '../agent/agent.module';
import { AgentsModule } from '../agents/agents.module';
import { FilesModule } from '../files/files.module';
import { UserMemoryModule } from '../user-memory/user-memory.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [TypeOrmModule.forFeature([Message]), ChatsModule, AgentModule, AgentsModule, FilesModule, UserMemoryModule, UsersModule],
  providers: [MessagesService],
  controllers: [MessagesController],
  exports: [MessagesService],
})
export class MessagesModule {}
