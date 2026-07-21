import {
  Controller, Get, Post, Put, Patch, Delete, Body, Param,
  UseGuards, HttpCode, HttpStatus, Inject,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsString, IsOptional, IsIn } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ProjectsService } from './projects.service';
import { ProjectTeamRole } from './project-team.entity';

class CreateProjectDto {
  @IsString() name: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() color?: string;
  @IsOptional() @IsString() systemPrompt?: string | null;
}

class AddTeamDto {
  @IsString() teamId: string;
  @IsOptional() @IsIn(['collaborator', 'viewer']) role?: ProjectTeamRole;
}

class SetTeamRoleDto {
  @IsIn(['collaborator', 'viewer']) role: ProjectTeamRole;
}

@ApiTags('projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/projects')
export class ProjectsController {
  constructor(@Inject(ProjectsService) private readonly service: ProjectsService) {}

  @Get()
  @ApiOperation({ summary: 'List visible projects: own + shared with the team' })
  findAll(@CurrentUser() user: any) {
    return this.service.findAllForUser(user.id);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.findOne(id, user.id, user.role);
  }

  @Post()
  create(@Body() dto: CreateProjectDto, @CurrentUser() user: any) {
    return this.service.create(user.id, dto);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: CreateProjectDto, @CurrentUser() user: any) {
    return this.service.update(id, user.id, user.role, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.remove(id, user.id, user.role);
  }

  // ── Team sharing (management: owner or admin) ──────────────────────

  @Get(':id/teams')
  @ApiOperation({ summary: 'Teams assigned to the project' })
  listTeams(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.listTeams(id, user.id, user.role);
  }

  @Post(':id/teams')
  @ApiOperation({ summary: 'Assign a team to the project (owner/admin)' })
  addTeam(@Param('id') id: string, @Body() dto: AddTeamDto, @CurrentUser() user: any) {
    return this.service.addTeam(id, user.id, user.role, dto.teamId, dto.role ?? 'collaborator');
  }

  @Patch(':id/teams/:teamId')
  @ApiOperation({ summary: 'Change a team\'s role on the project (owner/admin)' })
  setTeamRole(
    @Param('id') id: string,
    @Param('teamId') teamId: string,
    @Body() dto: SetTeamRoleDto,
    @CurrentUser() user: any,
  ) {
    return this.service.setTeamRole(id, user.id, user.role, teamId, dto.role);
  }

  @Delete(':id/teams/:teamId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a team from the project (owner/admin)' })
  async removeTeam(@Param('id') id: string, @Param('teamId') teamId: string, @CurrentUser() user: any) {
    await this.service.removeTeam(id, user.id, user.role, teamId);
    return { removed: true };
  }
}
