import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Project } from './projects.entity';
import { ProjectTeam } from './project-team.entity';
import { ProjectsService } from './projects.service';
import { ProjectsController } from './projects.controller';
import { TeamsModule } from '../teams/teams.module';

@Module({
  imports: [TypeOrmModule.forFeature([Project, ProjectTeam]), TeamsModule],
  providers: [ProjectsService],
  controllers: [ProjectsController],
  exports: [ProjectsService],
})
export class ProjectsModule {}
