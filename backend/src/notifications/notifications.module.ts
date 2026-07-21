import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { Notification }           from './notification.entity';
import { NotificationsGateway }   from './notifications.gateway';
import { NotificationsService }   from './notifications.service';
import { NotificationsController } from './notifications.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([Notification]),
    ConfigModule,
    JwtModule.registerAsync({
      imports:    [ConfigModule],
      inject:     [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        secret: cfg.get<string>('JWT_SECRET'),
      }),
    }),
  ],
  providers:   [NotificationsGateway, NotificationsService],
  controllers: [NotificationsController],
  exports:     [NotificationsGateway, NotificationsService],
})
export class NotificationsModule {}
