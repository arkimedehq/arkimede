// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file plugins.controller.ts
 *
 * The plugins' HTTP side (specs/PLUGINS.md):
 *   - api/plugins — any signed-in user: the contract, the pages they see (the menu), a page's URL, and the plugins'
 *     routes (`api/plugins/<name>/routes/<path>`, run as the user);
 *   - api/admin/plugins — the admin: install (ZIP or registry), review, approve or reject, scope and agent, settings,
 *     people, events, enable, disable, uninstall, trusted keys;
 *   - api/plugin-ui/<page token>/<file> — a page's files for its iframe (no JWT: the signed token is in the path);
 *   - internal/plugins — the plugin's own calls (its token): events and services.
 */
import {
  All, BadRequestException, Body, Controller, Delete, Get, HttpCode, HttpStatus, NotFoundException, Param, ParseUUIDPipe,
  Post, Put, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { IsArray, IsBoolean, IsIn, IsObject, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import type { Request, Response } from 'express';
import * as path from 'path';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PluginsService } from './plugins.service';
import { PluginRuntimeService } from './plugin-runtime.service';
import { PluginRegistryService } from './plugin-registry.service';
import { PluginTokenGuard } from './plugin-token.guard';
import { Plugin } from './plugin.entity';
import { mintPageToken, readPageToken } from './plugin-trust';

class AccessDto {
  @IsOptional() @IsIn(['personal', 'team', 'org']) scope?: 'personal' | 'team' | 'org';
  @IsOptional() @IsUUID() teamId?: string | null;
  @IsOptional() @IsUUID() agentId?: string | null;
}

class SettingsDto {
  @IsObject() values: Record<string, string>;
}

class IdentityDto {
  @IsString() @MaxLength(256) externalId: string;
  @IsOptional() @IsUUID() userId?: string | null;
  @IsOptional() @IsBoolean() authorized?: boolean;
  @IsOptional() @IsString() @MaxLength(128) displayName?: string | null;
  /** A Home Assistant person (`person.*`); an admin only. Null unlinks it. */
  @IsOptional() @IsString() @MaxLength(255) haPerson?: string | null;
}

class TrustKeyDto {
  @IsString() @MaxLength(128) keyId: string;
  @IsIn(['verified', 'community']) level: 'verified' | 'community';
  @IsString() @MaxLength(2000) publicKey: string;
}

class AllowUnsignedDto {
  @IsBoolean() allowUnsigned: boolean;
}

class RegistryInstallDto {
  @IsString() @MaxLength(64) name: string;
  /** An admin installing a copy on a user's behalf. */
  @IsOptional() @IsUUID() forUserId?: string | null;
}

class EventsDto {
  @IsArray() events: any[];
}

const zipUpload = FileInterceptor('file', {
  storage: memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const zip = file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed' || file.originalname.toLowerCase().endsWith('.zip');
    cb(zip ? null : new BadRequestException('Only ZIP packages are accepted'), zip);
  },
});

/** The admin's view of a plugin: no secrets, the manifest of what runs and of what waits. */
function view(p: Plugin) {
  return {
    id: p.id, name: p.name, version: p.version, contract: p.contract, label: (p.manifest ?? p.pendingManifest)?.label ?? p.name,
    description: (p.manifest ?? p.pendingManifest)?.description ?? '', status: p.status, statusDetail: p.statusDetail,
    scope: p.scope, teamId: p.teamId, agentId: p.agentId, ownerId: p.ownerId, audience: p.audience, trust: p.trust, signedBy: p.signedBy,
    sha256: p.sha256, grants: p.grants, pending: !!p.pendingManifest, approvedAt: p.approvedAt, updatedAt: p.updatedAt,
  };
}

@ApiTags('plugins')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/plugins')
export class PluginsController {
  constructor(private readonly plugins: PluginsService, private readonly runtime: PluginRuntimeService) {}

  @Get('contract')
  @ApiOperation({ summary: 'The plugin-contract versions this Arkimede runs' })
  contract() {
    return this.plugins.contract();
  }

  @Get('pages')
  @ApiOperation({ summary: 'The pages of the active plugins the user sees (the menu)' })
  pages(@CurrentUser() user: any) {
    return this.plugins.pagesFor(user.id);
  }

  @Get(':name/pages/:page/url')
  @ApiOperation({ summary: 'A signed URL (one hour) for a plugin page, to load in an isolated iframe' })
  async pageUrl(@Param('name') name: string, @Param('page') pageId: string, @CurrentUser() user: any) {
    const plugin = await this.plugins.activeFor(name, user.id);
    const page = plugin.manifest!.contributes.ui.pages.find((p) => p.id === pageId);
    if (!page) throw new NotFoundException('Page not found');
    return { url: `/api/plugin-ui/${mintPageToken(plugin.id, user.id)}/${page.entry}`, title: page.title };
  }

  @All(':name/routes/*')
  @ApiOperation({ summary: "A plugin route: runs the route's script as the user" })
  async route(@Param('name') name: string, @Req() req: Request, @Res() res: Response, @CurrentUser() user: any) {
    const subpath = String((req.params as any)[0] ?? '');
    const answer = await this.runtime.route(name, req.method, subpath, req.query as Record<string, unknown>, req.body, user);
    res.status(answer.status).json(answer.body);
  }
}

/**
 * Installed copies (specs/EXTENSION_AUDIENCE.md): an admin manages every copy, a user their own. Approving, rejecting,
 * sharing (scope) and the trusted keys are the admin's; installing is anyone's, from trusted sources.
 */
@ApiTags('plugins')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/plugin-installs')
export class PluginInstallsController {
  constructor(private readonly plugins: PluginsService, private readonly registry: PluginRegistryService) {}

  @Get()
  async list(@CurrentUser() user: any) {
    return (await this.plugins.findAll(user.id, user.role === 'admin')).map(view);
  }

  @Get('trust')
  @UseGuards(AdminGuard)
  trust() {
    return this.plugins.trustSettings();
  }

  @Put('trust/unsigned')
  @UseGuards(AdminGuard)
  async allowUnsigned(@Body() dto: AllowUnsignedDto, @CurrentUser() user: any) {
    await this.plugins.setAllowUnsigned(dto.allowUnsigned, user.id);
    return this.plugins.trustSettings();
  }

  @Post('trust/keys')
  @UseGuards(AdminGuard)
  async addKey(@Body() dto: TrustKeyDto, @CurrentUser() user: any) {
    await this.plugins.addTrustedKey(dto, user.id);
    return this.plugins.trustSettings();
  }

  @Delete('trust/keys/:id')
  @UseGuards(AdminGuard)
  async removeKey(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    await this.plugins.removeTrustedKey(id, user.id);
    return this.plugins.trustSettings();
  }

  @Get('registry')
  registryList(@Query('refresh') refresh?: string) {
    return this.registry.list(refresh === '1' || refresh === 'true');
  }

  @Post('registry/install')
  async registryInstall(@Body() dto: RegistryInstallDto, @CurrentUser() user: any) {
    const { buffer, entry } = await this.registry.download(dto.name);
    return this.withView(await this.plugins.install(buffer, user.id, {
      signature: entry.signature, keyId: entry.keyId, fromRegistry: true, isAdmin: user.role === 'admin', forUserId: dto.forUserId,
    }));
  }

  @Post('upload')
  @UseInterceptors(zipUpload)
  @ApiOperation({ summary: 'Install or update a plugin from a ZIP (multipart: file, signature, keyId; forUserId for an admin)' })
  async upload(@UploadedFile() file: Express.Multer.File, @Body() body: { signature?: string; keyId?: string; forUserId?: string }, @CurrentUser() user: any) {
    if (!file) throw new BadRequestException('No file uploaded');
    return this.withView(await this.plugins.install(file.buffer, user.id, {
      signature: body?.signature, keyId: body?.keyId, isAdmin: user.role === 'admin', forUserId: body?.forUserId || null,
    }));
  }

  @Post(':id/upload')
  @UseInterceptors(zipUpload)
  @ApiOperation({ summary: 'Update (or reinstall) this copy from a ZIP of the same plugin, keeping its settings and people' })
  async uploadUpdate(@Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: Express.Multer.File, @Body() body: { signature?: string; keyId?: string }, @CurrentUser() user: any) {
    if (!file) throw new BadRequestException('No file uploaded');
    await this.managed(id, user);
    return this.withView(await this.plugins.install(file.buffer, user.id, {
      signature: body?.signature, keyId: body?.keyId, isAdmin: user.role === 'admin', targetId: id,
    }));
  }

  @Get(':id')
  @ApiOperation({ summary: 'A copy: review (manifest, permissions, what is new), contents, settings, people' })
  async detail(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    await this.managed(id, user);
    const review = await this.plugins.review(id);
    const [contents, settings, identities] = await Promise.all([
      this.plugins.contents(id), this.plugins.settings(id), this.plugins.identities(id),
    ]);
    return { ...this.withView(review), contents, settings, identities };
  }

  @Get(':id/events')
  async events(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any, @Query('limit') limit?: string) {
    await this.managed(id, user);
    return this.plugins.events(id, Number(limit) || 100);
  }

  @Post(':id/approve')
  @UseGuards(AdminGuard)
  async approve(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AccessDto, @CurrentUser() user: any) {
    return view(await this.plugins.approve(id, user.id, dto));
  }

  @Post(':id/reject')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async reject(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    await this.plugins.reject(id, user.id);
  }

  @Post(':id/enable')
  async enable(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    await this.managed(id, user);
    return view(await this.plugins.enable(id, user.id));
  }

  @Post(':id/disable')
  async disable(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    await this.managed(id, user);
    return view(await this.plugins.disable(id, user.id));
  }

  @Put(':id/access')
  async access(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AccessDto, @CurrentUser() user: any) {
    await this.managed(id, user);
    return view(await this.plugins.setAccess(id, user.id, dto, user.role === 'admin'));
  }

  @Put(':id/settings')
  async setSettings(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SettingsDto, @CurrentUser() user: any) {
    await this.managed(id, user);
    await this.plugins.setSettings(id, dto.values, user.id);
    return this.plugins.settings(id);
  }

  @Put(':id/identities')
  async setIdentity(@Param('id', ParseUUIDPipe) id: string, @Body() dto: IdentityDto, @CurrentUser() user: any) {
    await this.managed(id, user);
    return this.plugins.setIdentity(id, dto.externalId, dto, user.id, user.role === 'admin');
  }

  /** The people the plugin knows (its people script), to pick one in the People card; `refresh` skips the minute's cache. */
  @Get(':id/known-people')
  async knownPeople(@Param('id', ParseUUIDPipe) id: string, @Query('refresh') refresh: string | undefined, @CurrentUser() user: any) {
    await this.managed(id, user);
    return this.plugins.knownPeople(id, refresh === '1');
  }

  @Delete(':id/identities/:identityId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeIdentity(@Param('id', ParseUUIDPipe) id: string, @Param('identityId', ParseUUIDPipe) identityId: string, @CurrentUser() user: any) {
    await this.managed(id, user);
    await this.plugins.removeIdentity(id, identityId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async uninstall(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    await this.managed(id, user);
    await this.plugins.uninstall(id, user.id);
  }

  /** The copy, when the user manages it (an admin, or its owner); 404 otherwise (another's copy is not revealed). */
  private async managed(id: string, user: any): Promise<Plugin> {
    const plugin = await this.plugins.findOne(id);
    if (!this.plugins.canManage(plugin, user)) throw new NotFoundException('Plugin not found');
    return plugin;
  }

  private withView<T extends { plugin: Plugin }>(r: T) {
    return { ...r, plugin: view(r.plugin) };
  }
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};
/**
 * A page file's path, normalized: null when it is absolute, climbs out (`..`) or is empty. The check on the pages'
 * folders runs on this, so `ui/../plugin.yaml` is never "under ui/".
 */
export function pagePath(raw: string): string | null {
  if (!raw || raw.includes('\0') || raw.includes('\\') || raw.startsWith('/')) return null;
  const rel = path.posix.normalize(raw);
  return rel === '.' || rel === '..' || rel.startsWith('../') || rel.startsWith('/') ? null : rel;
}

/** What a plugin page may do: its own files and inline code; no network at all (the bridge is the only way out). */
const PAGE_CSP = "default-src 'self' 'unsafe-inline' data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

@ApiTags('plugins')
@Controller('api/plugin-ui')
export class PluginUiController {
  constructor(private readonly plugins: PluginsService) {}

  /** A file of a plugin's pages: only under the folders of its declared page entries, for the user of the token. */
  @Get(':token/*')
  async file(@Param('token') token: string, @Req() req: Request, @Res() res: Response) {
    const claims = readPageToken(token);
    const rel = pagePath(String((req.params as any)[0] ?? ''));
    const notFound = () => res.status(404).type('text/plain').send('Not found');
    if (!claims || !rel) return notFound();
    const plugin = await this.plugins.findOne(claims.pid).catch(() => null);
    if (!plugin || plugin.status !== 'active' || !plugin.manifest || !(await this.plugins.visibleTo(plugin, claims.uid))) return notFound();
    const dirs = plugin.manifest.contributes.ui.pages.map((p) => path.posix.dirname(p.entry));
    const entries = new Set(plugin.manifest.contributes.ui.pages.map((p) => p.entry));
    const allowed = entries.has(rel) || dirs.some((d) => d !== '.' && rel.startsWith(`${d}/`));
    const file = allowed ? this.plugins.packageFile(plugin.id, rel) : null;
    if (!file) return notFound();
    res.setHeader('Content-Type', CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
    res.setHeader('Content-Security-Policy', PAGE_CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.sendFile(file);
  }
}

@ApiTags('plugins')
@UseGuards(PluginTokenGuard)
@Controller('internal/plugins')
export class InternalPluginsController {
  constructor(private readonly runtime: PluginRuntimeService) {}

  @Post('events')
  @HttpCode(HttpStatus.OK)
  async events(@Body() dto: EventsDto, @Req() req: Request & { plugin: Plugin }) {
    return { results: await this.runtime.emit(req.plugin, dto.events) };
  }

  @Post('services/:service')
  @HttpCode(HttpStatus.OK)
  service(@Param('service') service: string, @Body() body: unknown, @Req() req: Request & { plugin: Plugin }) {
    return this.runtime.call(req.plugin, service, body);
  }
}
