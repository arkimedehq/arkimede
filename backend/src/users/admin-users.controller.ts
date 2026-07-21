import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, HttpStatus,
  Inject, Optional, Param, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import {
  IsEmail, IsIn, IsInt, IsOptional, IsString, Max, Min, MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UsersService } from './users.service';
import { AuditService } from '../audit/audit.service';
import { UserRole, UserStatus } from './users.entity';

const ROLES: UserRole[]     = ['admin', 'user'];
const STATUSES: UserStatus[] = ['active', 'disabled'];

class ListUsersQuery {
  @IsOptional() @IsString()
  search?: string;

  @IsOptional() @IsIn(ROLES)
  role?: UserRole;

  @IsOptional() @IsIn(STATUSES)
  status?: UserStatus;

  @IsOptional() @IsInt() @Min(1) @Type(() => Number)
  page?: number;

  @IsOptional() @IsInt() @Min(1) @Max(100) @Type(() => Number)
  pageSize?: number;
}

class CreateUserDto {
  @IsEmail() email: string;
  @IsString() name: string;
  @IsString() @MinLength(6) password: string;
  @IsOptional() @IsIn(ROLES) role?: UserRole;
}

class UpdateUserDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsEmail() email?: string;
}

class SetRoleDto {
  @IsString() @IsIn(ROLES) role: UserRole;
}

class SetStatusDto {
  @IsString() @IsIn(STATUSES) status: UserStatus;
}

class ResetPasswordDto {
  @IsString() @MinLength(6) newPassword: string;
}

/**
 * User management reserved for org administrators.
 * All routes are protected by JwtAuthGuard + AdminGuard.
 *
 * Security convention: destructive operations on oneself
 * (self-demotion/self-disabling) are blocked here; the
 * "last active admin" rule is enforced in the service.
 */
@ApiTags('admin/users')
@Controller('api/admin/users')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminUsersController {
  constructor(
    @Inject(UsersService) private readonly users: UsersService,
    @Optional() private readonly audit?: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List users (paginated, with filters)' })
  list(@Query() q: ListUsersQuery) {
    return this.users.listUsers(q);
  }

  @Get(':id')
  @ApiOperation({ summary: 'User detail' })
  getOne(@Param('id') id: string) {
    return this.users.getById(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create user' })
  async create(@Body() dto: CreateUserDto, @CurrentUser() current: { id: string }) {
    const u = await this.users.adminCreate(dto);
    await this.audit?.record({
      actorId: current.id, action: 'user.create', resource: dto.email,
      outcome: 'ok', ctx: { targetUserId: (u as any)?.id, role: dto.role },
    });
    return u;
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update name/email' })
  async update(@Param('id') id: string, @Body() dto: UpdateUserDto, @CurrentUser() current: { id: string }) {
    const u = await this.users.adminUpdate(id, dto);
    await this.audit?.record({
      actorId: current.id, action: 'user.update', resource: id,
      outcome: 'ok', ctx: { targetUserId: id },
    });
    return u;
  }

  @Patch(':id/role')
  @ApiOperation({ summary: 'Change role' })
  async setRole(
    @Param('id') id: string,
    @Body() dto: SetRoleDto,
    @CurrentUser() current: { id: string },
  ) {
    if (id === current.id && dto.role !== 'admin') {
      throw new BadRequestException('users.cannotRemoveOwnAdmin');
    }
    const u = await this.users.setRole(id, dto.role);
    await this.audit?.record({
      actorId: current.id, action: 'user.role_change', resource: id,
      outcome: 'ok', ctx: { targetUserId: id, role: dto.role },
    });
    return u;
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Enable/disable account' })
  async setStatus(
    @Param('id') id: string,
    @Body() dto: SetStatusDto,
    @CurrentUser() current: { id: string },
  ) {
    if (id === current.id && dto.status === 'disabled') {
      throw new BadRequestException('users.cannotDisableOwnAccount');
    }
    const u = await this.users.setStatus(id, dto.status);
    await this.audit?.record({
      actorId: current.id, action: 'user.status_change', resource: id,
      outcome: 'ok', ctx: { targetUserId: id, status: dto.status },
    });
    return u;
  }

  @Post(':id/reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Reset user password' })
  async resetPassword(@Param('id') id: string, @Body() dto: ResetPasswordDto, @CurrentUser() current: { id: string }) {
    await this.users.adminResetPassword(id, dto.newPassword);
    await this.audit?.record({
      actorId: current.id, action: 'user.password_reset', resource: id,
      outcome: 'ok', ctx: { targetUserId: id },
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete user' })
  async remove(@CurrentUser() current: { id: string }, @Param('id') id: string) {
    if (id === current.id) {
      throw new BadRequestException('users.cannotDeleteOwnAccount');
    }
    await this.users.deleteUser(id);
    await this.audit?.record({
      actorId: current.id, action: 'user.delete', resource: id,
      outcome: 'ok', ctx: { targetUserId: id },
    });
  }
}
