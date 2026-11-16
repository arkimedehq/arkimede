// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file plugin-token.guard.ts
 *
 * The plugin's own calls (internal/plugins/*): the `x-plugin-token` header must be a plugin token (plugin-trust.ts) of
 * an active plugin, at its current token version — disabling, updating or removing the plugin revokes every token it
 * had. The plugin is put on the request (`req.plugin`): who calls comes from the token, never from the body.
 */
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Plugin } from './plugin.entity';
import { readPluginToken } from './plugin-trust';

@Injectable()
export class PluginTokenGuard implements CanActivate {
  constructor(@InjectRepository(Plugin) private readonly repo: Repository<Plugin>) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const claims = readPluginToken(req.headers['x-plugin-token']);
    if (!claims) throw new UnauthorizedException('Plugin token missing or invalid');
    const plugin = await this.repo.findOne({ where: { id: claims.pid } });
    if (!plugin || plugin.status !== 'active' || !plugin.manifest || plugin.tokenVersion !== claims.v) {
      throw new UnauthorizedException('Plugin token revoked');
    }
    req.plugin = plugin;
    return true;
  }
}
