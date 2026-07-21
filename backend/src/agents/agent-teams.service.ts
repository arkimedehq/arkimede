/**
 * @file agent-teams.service.ts
 *
 * CRUD of **agent teams** + member management. Scope personal|team|org.
 */
import { Injectable, NotFoundException, ForbiddenException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { TeamsService } from '../teams/teams.service';
import { AuditService } from '../audit/audit.service';
import { AgentTeam } from './agent-team.entity';
import { AgentTeamMember } from './agent-team-member.entity';
import { AgentScope, TeamTopology } from './agent.types';

export interface UpsertTeamData {
  name: string;
  description?: string | null;
  topology?: TeamTopology;
  supervisorAgentId?: string | null;
  exposeAsTool?: boolean;
  scope?: AgentScope;
  teamId?: string | null;
}

export interface MemberInput {
  agentId: string;
  position?: number;
  role?: string | null;
}

@Injectable()
export class AgentTeamsService {
  constructor(
    @InjectRepository(AgentTeam) private readonly repo: Repository<AgentTeam>,
    @InjectRepository(AgentTeamMember) private readonly memberRepo: Repository<AgentTeamMember>,
    private readonly teams: TeamsService,
    @Optional() private readonly audit?: AuditService,
  ) {}

  async findAll(userId: string): Promise<AgentTeam[]> {
    const teamIds = await this.teams.teamIdsForUser(userId);
    return this.repo.find({ where: this.visibilityWhere(userId, teamIds), order: { updatedAt: 'DESC' } });
  }

  /** Teams visible to the user with `exposeAsTool=true` (for loadToolsForUser). */
  async findExposable(userId: string): Promise<AgentTeam[]> {
    const teamIds = await this.teams.teamIdsForUser(userId);
    return this.repo.find({
      where: this.visibilityWhere(userId, teamIds).map((w) => ({ ...w, exposeAsTool: true })),
    });
  }

  /** Accessible team + members (ordered by position). */
  async findOneAccessible(id: string, userId: string): Promise<AgentTeam & { members: AgentTeamMember[] }> {
    const team = await this.repo.findOne({ where: { id } });
    if (!team) throw new NotFoundException('agents.teamNotFound');
    await this.assertAccessible(team, userId);
    const members = await this.memberRepo.find({ where: { teamId: id }, order: { position: 'ASC' } });
    return Object.assign(team, { members });
  }

  async findById(id: string): Promise<AgentTeam> {
    const team = await this.repo.findOne({ where: { id } });
    if (!team) throw new NotFoundException('agents.teamNotFound');
    return team;
  }

  async create(userId: string, data: UpsertTeamData): Promise<AgentTeam> {
    const team = this.repo.create({
      userId,
      name: data.name,
      description: data.description ?? null,
      topology: data.topology ?? 'supervisor',
      supervisorAgentId: data.supervisorAgentId ?? null,
      exposeAsTool: data.exposeAsTool ?? false,
      scope: data.scope ?? 'personal',
      teamId: data.scope === 'team' ? (data.teamId ?? null) : null,
    });
    const saved = await this.repo.save(team);
    await this.audit?.record({
      actorId: userId,
      action: 'agentteam.create',
      resource: saved.name ?? saved.id,
      outcome: 'ok',
      ctx: { id: saved.id, topology: saved.topology, scope: saved.scope },
    });
    return saved;
  }

  async update(id: string, data: Partial<UpsertTeamData>): Promise<AgentTeam> {
    const team = await this.findById(id);
    if (data.name !== undefined) team.name = data.name;
    if (data.description !== undefined) team.description = data.description;
    if (data.topology !== undefined) team.topology = data.topology;
    if (data.supervisorAgentId !== undefined) team.supervisorAgentId = data.supervisorAgentId;
    if (data.exposeAsTool !== undefined) team.exposeAsTool = data.exposeAsTool;
    if (data.scope !== undefined) {
      team.scope = data.scope;
      team.teamId = data.scope === 'team' ? (data.teamId ?? team.teamId ?? null) : null;
    }
    return this.repo.save(team);
  }

  async remove(id: string, actorId?: string): Promise<void> {
    const team = await this.repo.findOne({ where: { id } });
    await this.repo.delete({ id });
    await this.audit?.record({
      actorId: actorId ?? null,
      action: 'agentteam.delete',
      resource: team?.name ?? id,
      outcome: 'ok',
      ctx: { id, topology: team?.topology, scope: team?.scope },
    });
  }

  /** Replaces the team members in bulk (simple for the UI editor). */
  async setMembers(teamId: string, members: MemberInput[]): Promise<AgentTeamMember[]> {
    await this.memberRepo.delete({ teamId });
    const rows = members.map((m, i) => this.memberRepo.create({
      teamId, agentId: m.agentId, position: m.position ?? i, role: m.role ?? null,
    }));
    return this.memberRepo.save(rows);
  }

  // ── Authorization ──────────────────────────────────────────────────────

  async assertCanManage(
    user: { id: string; role: string },
    scope: AgentScope,
    teamId: string | null | undefined,
    ownerId?: string,
  ): Promise<void> {
    if (scope === 'org') {
      if (user.role !== 'admin') throw new ForbiddenException('agents.teamOrgAdminOnly');
      return;
    }
    if (scope === 'team') {
      if (!teamId) throw new ForbiddenException('agents.teamIdMissing');
      if (user.role === 'admin') return;
      if (await this.teams.isOwner(teamId, user.id)) return;
      throw new ForbiddenException('agents.agentTeamTeamAdminOnly');
    }
    if (ownerId !== undefined && ownerId !== user.id) {
      throw new ForbiddenException('agents.teamOwnerOnly');
    }
  }

  private async assertAccessible(team: AgentTeam, userId: string): Promise<void> {
    if (team.userId === userId) return;
    if (team.scope === 'org') return;
    if (team.scope === 'team' && team.teamId && (await this.teams.isMember(team.teamId, userId))) return;
    throw new ForbiddenException('agents.teamAccessDenied');
  }

  private visibilityWhere(userId: string, teamIds: string[]) {
    const where: any[] = [{ userId }, { scope: 'org' }];
    if (teamIds.length) where.push({ scope: 'team', teamId: In(teamIds) });
    return where;
  }
}
