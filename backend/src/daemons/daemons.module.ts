import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SkillDaemon }               from './skill-daemon.entity';
import { DaemonsService }            from './daemons.service';
import { DaemonsController }         from './daemons.controller';
import { InternalDaemonsController } from './internal-daemons.controller';
import { SkillsModule }              from '../skills/skills.module';
import { NotificationsModule }       from '../notifications/notifications.module';
import { Skill }                     from '../skills/skill.entity';
import { SkillScript }               from '../skills/skill-script.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([SkillDaemon, Skill, SkillScript]),
    SkillsModule,
    NotificationsModule,   // exports both Gateway and Service
  ],
  providers:   [DaemonsService],
  controllers: [DaemonsController, InternalDaemonsController],
  exports:     [DaemonsService],
})
export class DaemonsModule {}
