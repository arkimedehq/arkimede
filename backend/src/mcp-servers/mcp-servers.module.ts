// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { McpServer } from './mcp-server.entity';
import { AppConfigEntity } from '../app-config/app-config.entity';
import { McpServerSecret } from './mcp-server-secret.entity';
import { McpServersService } from './mcp-servers.service';
import { McpServersController } from './mcp-servers.controller';
import { McpBridgeGateway } from './mcp-bridge.gateway';
import { AuditModule } from '../audit/audit.module';
import { TeamsModule } from '../teams/teams.module';

@Module({
  imports: [
    AuditModule,
    TeamsModule,
    TypeOrmModule.forFeature([McpServer, McpServerSecret, AppConfigEntity]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject:  [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        secret:      cfg.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: cfg.get<string>('JWT_EXPIRES_IN', '7d') },
      }),
    }),
  ],
  controllers: [McpServersController],
  providers:   [McpServersService, McpBridgeGateway],
  exports:     [McpServersService],
})
export class McpServersModule {}
