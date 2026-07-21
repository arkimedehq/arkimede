import {
  Controller, Get, Post, Patch, Delete, Body, Param,
  UseGuards, Inject,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsIn, IsOptional, IsBoolean, ArrayNotEmpty, IsArray, IsString, IsUUID } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserMemoryService } from './user-memory.service';

class ConfirmDto {
  @IsArray() @ArrayNotEmpty() @IsUUID('all', { each: true })
  ids: string[];
}

class ExtractDto {
  @IsUUID() chatId: string;
}

class ContentDto {
  @IsString() content: string;
}

class PinnedDto {
  @IsBoolean() pinned: boolean;
}

class ScopeDto {
  @IsIn(['personal', 'team', 'org']) scope: 'personal' | 'team' | 'org';
  @IsOptional() @IsUUID() teamId?: string | null;
}

@ApiTags('user-memory')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/user-memory')
export class UserMemoryController {
  constructor(
    @Inject(UserMemoryService) private readonly memory: UserMemoryService,
  ) {}

  /** All facts of the user (confirmed + pending), for the management panel. */
  @Get()
  @ApiOperation({ summary: 'User memory list (confirmed + pending)' })
  list(@CurrentUser() user: any) {
    return this.memory.listAll(user.id);
  }

  /** On-demand extraction from the current chat → returns the pending proposals. */
  @Post('extract')
  @ApiOperation({ summary: 'Extract memory on-demand from a chat' })
  async extract(@CurrentUser() user: any, @Body() dto: ExtractDto) {
    const proposals = await this.memory.extractForChat(user.id, dto.chatId);
    return { proposals };
  }

  /** Confirms pending facts (they move into active memory). */
  @Post('confirm')
  @ApiOperation({ summary: 'Confirm pending facts' })
  async confirm(@CurrentUser() user: any, @Body() dto: ConfirmDto) {
    await this.memory.confirm(user.id, dto.ids);
    return { ok: true };
  }

  /** Manual insertion of a fact already confirmed. */
  @Post()
  @ApiOperation({ summary: 'Add a fact manually' })
  add(@CurrentUser() user: any, @Body() dto: ContentDto) {
    return this.memory.addManual(user.id, dto.content);
  }

  /** Edits the text of a fact. */
  @Patch(':id')
  @ApiOperation({ summary: 'Edit a fact' })
  update(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: ContentDto) {
    return this.memory.update(user.id, id, dto.content);
  }

  /** Pins/unpins a note: pinned notes are always injected (stable prefix). */
  @Patch(':id/pinned')
  @ApiOperation({ summary: 'Pin/unpin a note (always injected)' })
  setPinned(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: PinnedDto) {
    return this.memory.setPinned(user.id, id, dto.pinned);
  }

  /** Changes a note's visibility (F4): personal | team (membership) | org (admin). */
  @Patch(':id/scope')
  @ApiOperation({ summary: 'Share a note with a team or the org' })
  setScope(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: ScopeDto) {
    return this.memory.setScope(user.id, id, dto.scope, dto.teamId ?? null, user.role === 'admin');
  }

  /** One-shot backfill: enriches legacy notes and (re)indexes all confirmed ones. */
  @Post('reindex')
  @ApiOperation({ summary: 'Backfill metadata and rebuild the vector index for own notes' })
  reindex(@CurrentUser() user: any) {
    return this.memory.reindexAll(user.id);
  }

  /** Deletes a fact (rejects a pending one or removes a confirmed one). */
  @Delete(':id')
  @ApiOperation({ summary: 'Delete a fact' })
  async remove(@CurrentUser() user: any, @Param('id') id: string) {
    await this.memory.remove(user.id, id);
    return { ok: true };
  }
}
