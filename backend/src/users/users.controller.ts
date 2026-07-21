import {Body, Controller, Get, HttpCode, HttpStatus, Inject, Optional, Patch, Post, UseGuards,} from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CurrentUser} from '../common/decorators/current-user.decorator';
import {UsersService} from './users.service';
import { AuditService } from '../audit/audit.service';
import { ToolLoadingStrategy, ToolSchemaFormat } from '../app-config/app-config.entity';

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

  /** Override memory extraction threshold (no. of messages); null = global default. */
  @IsOptional() @IsInt() @Min(1) @Max(100) @Type(() => Number)
  memoryThreshold?: number | null;
}

class ChangePasswordDto {
  currentPassword: string;
  newPassword: string;
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
