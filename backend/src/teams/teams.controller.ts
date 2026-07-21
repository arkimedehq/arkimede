import {
  Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param,
  Optional, Patch, Post, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { IsHexColor, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { TeamsService } from './teams.service';
import { AuditService } from '../audit/audit.service';
import { TeamRole } from './team-membership.entity';

const TEAM_ROLES: TeamRole[] = ['owner', 'member'];

class CreateTeamDto {
  @IsString() @MinLength(2) @MaxLength(60) name: string;
  @IsOptional() @IsString() @MaxLength(280) description?: string | null;
  @IsOptional() @IsHexColor() color?: string | null;
}

class UpdateTeamDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(60) name?: string;
  @IsOptional() @IsString() @MaxLength(280) description?: string | null;
  @IsOptional() @IsHexColor() color?: string | null;
}

class AddMemberDto {
  @IsUUID() userId: string;
  @IsOptional() @IsIn(TEAM_ROLES) role?: TeamRole;
}

class SetMemberRoleDto {
  @IsString() @IsIn(TEAM_ROLES) role: TeamRole;
}

/**
 * Team management.
 * - Write routes (team CRUD + members) are reserved for admins.
 * - `GET /api/teams/mine` is accessible to every authenticated user to
 *   know which teams they belong to (used by the UI and resource scoping).
 */
@ApiTags('teams')
@Controller('api/teams')
@UseGuards(JwtAuthGuard)
export class TeamsController {
  constructor(
    @Inject(TeamsService) private readonly teams: TeamsService,
    @Optional() private readonly audit?: AuditService,
  ) {}

  /** Current user's teams (any role). */
  @Get('mine')
  @ApiOperation({ summary: 'Current user\'s teams' })
  mine(@CurrentUser() user: { id: string }) {
    return this.teams.teamsForUser(user.id);
  }

  @Get()
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'List teams (admin)' })
  list() {
    return this.teams.list();
  }

  @Get(':id')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Team detail (admin)' })
  getOne(@Param('id') id: string) {
    return this.teams.getById(id);
  }

  @Post()
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Create team (admin)' })
  async create(@Body() dto: CreateTeamDto, @CurrentUser() user: { id: string }) {
    const team = await this.teams.create(dto);
    await this.audit?.record({
      actorId: user.id, action: 'team.create', resource: dto.name,
      outcome: 'ok', ctx: { teamId: (team as any)?.id },
    });
    return team;
  }

  @Patch(':id')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Update team (admin)' })
  async update(@Param('id') id: string, @Body() dto: UpdateTeamDto, @CurrentUser() user: { id: string }) {
    const team = await this.teams.update(id, dto);
    await this.audit?.record({
      actorId: user.id, action: 'team.update', resource: id,
      outcome: 'ok', ctx: { teamId: id },
    });
    return team;
  }

  @Delete(':id')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete team (admin)' })
  async remove(@Param('id') id: string, @CurrentUser() user: { id: string }) {
    await this.teams.remove(id);
    await this.audit?.record({
      actorId: user.id, action: 'team.delete', resource: id,
      outcome: 'ok', ctx: { teamId: id },
    });
  }

  // ── Members ─────────────────────────────────────────────────────────────

  @Get(':id/members')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Team members (admin)' })
  members(@Param('id') id: string) {
    return this.teams.listMembers(id);
  }

  @Post(':id/members')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Add member (admin)' })
  async addMember(@Param('id') id: string, @Body() dto: AddMemberDto, @CurrentUser() user: { id: string }) {
    const m = await this.teams.addMember(id, dto.userId, dto.role ?? 'member');
    await this.audit?.record({
      actorId: user.id, action: 'team.member_add', resource: id,
      outcome: 'ok', ctx: { teamId: id, targetUserId: dto.userId, role: dto.role ?? 'member' },
    });
    return m;
  }

  @Patch(':id/members/:userId')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Change member role (admin)' })
  async setMemberRole(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body() dto: SetMemberRoleDto,
    @CurrentUser() user: { id: string },
  ) {
    const m = await this.teams.setMemberRole(id, userId, dto.role);
    await this.audit?.record({
      actorId: user.id, action: 'team.member_role_change', resource: id,
      outcome: 'ok', ctx: { teamId: id, targetUserId: userId, role: dto.role },
    });
    return m;
  }

  @Delete(':id/members/:userId')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove member (admin)' })
  async removeMember(@Param('id') id: string, @Param('userId') userId: string, @CurrentUser() user: { id: string }) {
    await this.teams.removeMember(id, userId);
    await this.audit?.record({
      actorId: user.id, action: 'team.member_remove', resource: id,
      outcome: 'ok', ctx: { teamId: id, targetUserId: userId },
    });
  }
}
