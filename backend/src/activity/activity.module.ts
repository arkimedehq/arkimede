import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ActivityService } from './activity.service';
import { ActivityController } from './activity.controller';
import { FlowRun } from '../flows/flow-run.entity';
import { DaemonsModule } from '../daemons/daemons.module';
import { FlowsModule } from '../flows/flows.module';
import { SchedulingModule } from '../scheduling/scheduling.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([FlowRun]),
    DaemonsModule,     // DaemonsService
    FlowsModule,       // FlowsService
    SchedulingModule,  // SchedulingService
  ],
  providers: [ActivityService],
  controllers: [ActivityController],
})
export class ActivityModule {}
