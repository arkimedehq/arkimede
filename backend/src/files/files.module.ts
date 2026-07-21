import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { File } from './files.entity';
import { Message } from '../messages/messages.entity';
import { FilesService } from './files.service';
import { FilesController } from './files.controller';
import { InternalFilesController } from './internal-files.controller';
import { FileStreamAccessGuard } from './raw-file-access.guard';
import { ProjectsModule } from '../projects/projects.module';
import { TeamsModule } from '../teams/teams.module';
import { LlmConfigsModule } from '../llm-configs/llm-configs.module';
import { DataSourcesModule } from '../datasources/datasources.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([File, Message]),
    ProjectsModule,
    TeamsModule,
    LlmConfigsModule,
    DataSourcesModule,   // file-share streaming (SMB/SFTP/WebDAV + 'local')
    // Same key as login: signs/verifies file streaming tokens (?token=).
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        secret: cfg.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
  ],
  providers: [FilesService, FileStreamAccessGuard],
  controllers: [FilesController, InternalFilesController],
  exports: [FilesService],
})
export class FilesModule {}
