import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ScheduledTask } from './scheduled-task.entity';
import { SchedulingService } from './scheduling.service';
import { SchedulingController } from './scheduling.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { Chat } from '../chats/chats.entity';
import { Message } from '../messages/messages.entity';

@Module({
  imports: [
    // Chat + Message: outcome delivery as a chat message (direct repos → no cycles).
    TypeOrmModule.forFeature([ScheduledTask, Chat, Message]),
    NotificationsModule, // NotificationsService + NotificationsGateway (outcome delivery)
  ],
  providers: [SchedulingService],
  controllers: [SchedulingController],
  exports: [SchedulingService], // used by AgentModule for the built-in tool schedule_task
})
export class SchedulingModule {}
