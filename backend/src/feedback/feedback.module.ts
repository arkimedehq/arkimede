import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Feedback } from './feedback.entity';
import { Message } from '../messages/messages.entity';
import { FeedbackService } from './feedback.service';
import { FeedbackController } from './feedback.controller';
import { ChatsModule } from '../chats/chats.module';
import { AppConfigModule } from '../app-config/app-config.module';
import { EmbedModule } from '../embed/embed.module';
import { VectorDbModule } from '../vector-db/vector-db.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Feedback, Message]),
    ChatsModule,
    AppConfigModule,
    EmbedModule,
    VectorDbModule,
  ],
  providers: [FeedbackService],
  controllers: [FeedbackController],
  exports: [FeedbackService],
})
export class FeedbackModule {}
