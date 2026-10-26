// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import {Body, Controller, Get, HttpCode, HttpStatus, Inject, Optional, Patch, Post, UseGuards,} from '@nestjs/common';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CurrentUser} from '../common/decorators/current-user.decorator';
import {UsersService} from './users.service';
import { AuditService } from '../audit/audit.service';
import { ToolLoadingStrategy, ToolSchemaFormat } from '../app-config/app-config.entity';
import { RECORDARE_NOTE_CATEGORIES, USER_GENDERS, UserGender } from './users.entity';

const TOOL_STRATEGIES: ToolLoadingStrategy[] = ['always_inject_all', 'top_k_rag', 'auto'];
const TOOL_FORMATS: ToolSchemaFormat[]        = ['full', 'compressed', 'deferred'];

class UpdateProfileDto {
  @IsOptional() @IsString()
  name?: string;

  @IsOptional() @IsString()
  email?: string;

  @IsOptional() @IsString()
  systemPrompt?: string | null;

  /** Interface/response language ('it' | 'en'); null = no preference. */
  @IsOptional() @IsIn(['it', 'en', null])
  language?: string | null;

  /** Grammatical gender (also the first person of the Recordare memory); null = not set (masculine). */
  @IsOptional() @IsIn([...USER_GENDERS, null])
  gender?: UserGender | null;

  /** null = reset to the global admin default */
  @IsOptional() @IsIn([...TOOL_STRATEGIES, null])
  toolLoadingStrategy?: ToolLoadingStrategy | null;

  @IsOptional() @IsInt() @Min(1) @Max(100) @Type(() => Number)
  toolLoadingMaxTools?: number | null;

  /** null = reset to the global admin default */
  @IsOptional() @IsIn([...TOOL_FORMATS, null])
  toolSchemaFormat?: ToolSchemaFormat | null;

  /** null = use the global default (app_config.maxHistoryTokens, default 6000). */
  @IsOptional() @IsInt() @Min(500) @Max(32000) @Type(() => Number)
  maxHistoryTokens?: number | null;

  /** Show the input/output token count under each assistant message. */
  @IsOptional() @IsBoolean()
  showTokenCount?: boolean;

  /** Enable persistent user memory (automatic extraction on threshold). */
  @IsOptional() @IsBoolean()
  autoMemoryEnabled?: boolean;

  /** Use the team and organisation notes, apart from the personal memory (Recordare D34). */
  @IsOptional() @IsBoolean()
  sharedMemoryEnabled?: boolean;

  /** The copy rule: Recordare notes of these categories are copied into the personal memory (D34). */
  @IsOptional() @IsArray() @IsIn(RECORDARE_NOTE_CATEGORIES, { each: true })
  recordareCopyCategories?: string[];

  /** Enable episodic memory in Recordare (separate from autoMemoryEnabled). */
  @IsOptional() @IsBoolean()
  episodicMemoryEnabled?: boolean;

  /**
   * Recordare memory mode: personal (the account holder is "I") or entity (a shared agent; undeclared speakers are
   * "someone"); accepted only while the memory is empty.
   */
  @IsOptional() @IsIn(['personal', 'entity'])
  episodicMemoryMode?: 'personal' | 'entity';

  /** Override memory extraction threshold (no. of messages); null = global default. */
  @IsOptional() @IsInt() @Min(1) @Max(100) @Type(() => Number)
  memoryThreshold?: number | null;
}

// Decorators are required: the global ValidationPipe runs with whitelist:true and strips
// every undecorated property, which would leave both fields undefined.
class ChangePasswordDto {
  @IsString() currentPassword: string;
  @IsString() @MinLength(6) newPassword: string;
}

@Controller('api/users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(
    @Inject(UsersService) private readonly usersService: UsersService,
    @Optional() private readonly audit?: AuditService,
  ) {}

  /** GET /api/users/me — current profile */
  @Get('me')
  getMe(@CurrentUser() user: { id: string }) {
    return this.usersService.getProfile(user.id);
  }

  /** PATCH /api/users/me — update name and/or email */
  @Patch('me')
  updateMe(
    @CurrentUser() user: { id: string },
    @Body() dto: UpdateProfileDto,
  ) {
    return this.usersService.updateProfile(user.id, dto);
  }

  /** POST /api/users/me/change-password — change password */
  @Post('me/change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async changePassword(
    @CurrentUser() user: { id: string },
    @Body() dto: ChangePasswordDto,
  ) {
    await this.usersService.changePassword(
      user.id,
      dto.currentPassword,
      dto.newPassword,
    );
    await this.audit?.record({
      actorId: user.id, action: 'auth.password_change', resource: user.id, outcome: 'ok',
    });
  }
}
