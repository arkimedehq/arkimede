import { Controller, Get, Query, Req, ForbiddenException, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InternalTokenGuard, internalUserId } from '../common/guards/internal-token.guard';
import { FilesService } from './files.service';

/**
 * Internal files API (C2) — service-to-service (x-internal-api-key header).
 *
 * Used by skills (e.g. file-lookup) to search files in an **access-scoped** way
 * on behalf of the user running the skill (USER_ID injected into the subprocess
 * env), instead of scanning the filesystem (which would expose files of
 * other tenants).
 */
@ApiTags('internal')
@UseGuards(InternalTokenGuard)
@Controller('internal/files')
export class InternalFilesController {
  constructor(private readonly files: FilesService) {}

  @Get('search')
  async search(
    @Req() req: { internalAuth?: { sub?: string } },
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    // Identity comes from the signed run-token, NEVER from a caller-supplied param:
    // a skill running as A must not read B's files by passing ?userId=B. Fail-closed
    // for identity-less tokens (typ='system'). Mirrors the datasources/embed controllers.
    const userId = internalUserId(req);
    if (!userId) throw new ForbiddenException('Run without identity: file search denied.');
    const files = await this.files.searchReadable(userId, q ?? '', limit ? Number(limit) : 50);
    return files.map((f: any) => ({
      id:           f.id,
      filename:     f.originalName,
      rel:          f.rel ?? null,
      download_url: f.rel ?? null,
      size_bytes:   Number(f.size),
      scope:        f.scope,
      modified_at:  f.createdAt,
    }));
  }
}
