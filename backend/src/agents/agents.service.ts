/**
 * @file agents.service.ts
 *
 * CRUD of the Multi-Agent **agents**. Visibility/management with the same model
 * as custom tools / skills / flows: personal | team | org.
 */
import { Injectable, NotFoundException, ForbiddenException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { TeamsService } from '../teams/teams.service';
import { AuditService } from '../audit/audit.service';
import { Agent } from './agent.entity';
import { AgentScope, AgentToolFilter } from './agent.types';

export interface UpsertAgentData {
  name: string;
  description?: string | null;
  systemPrompt?: string;
  llmConfigId?: string | null;
  toolFilter?: AgentToolFilter;
  maxIterations?: number | null;
  exposeAsTool?: boolean;
  scope?: AgentScope;
  teamId?: string | null;
}

@Injectable()
export class AgentsService {
  constructor(
    @InjectRepository(Agent) private readonly repo: Repository<Agent>,
    private readonly teams: TeamsService,
    @Optional() private readonly audit?: AuditService,
  ) {}

  async findAll(userId: string): Promise<Agent[]> {
    const teamIds = await this.teams.teamIdsForUser(userId);
    return this.repo.find({ where: this.visibilityWhere(userId, teamIds), order: { updatedAt: 'DESC' } });
  }

  /** Agents visible to the user with `exposeAsTool=true` (for loadToolsForUser). */
  async findExposable(userId: string): Promise<Agent[]> {
    const teamIds = await this.teams.teamIdsForUser(userId);
    return this.repo.find({
      where: this.visibilityWhere(userId, teamIds).map((w) => ({ ...w, exposeAsTool: true })),
    });
  }

  async findOneAccessible(id: string, userId: string): Promise<Agent> {
    const agent = await this.repo.findOne({ where: { id } });
    if (!agent) throw new NotFoundException('agents.agentNotFound');
    await this.assertAccessible(agent, userId);
    return agent;
  }

  async findById(id: string): Promise<Agent> {
    const agent = await this.repo.findOne({ where: { id } });
    if (!agent) throw new NotFoundException('agents.agentNotFound');
    return agent;
  }

  async create(userId: string, data: UpsertAgentData): Promise<Agent> {
    const agent = this.repo.create({
      userId,
      name: data.name,
      description: data.description ?? null,
      systemPrompt: data.systemPrompt ?? '',
      llmConfigId: data.llmConfigId ?? null,
      toolFilter: data.toolFilter ?? { mode: 'all' },
      maxIterations: data.maxIterations ?? null,
      exposeAsTool: data.exposeAsTool ?? false,
      scope: data.scope ?? 'personal',
      teamId: data.scope === 'team' ? (data.teamId ?? null) : null,
    });
    const saved = await this.repo.save(agent);
    await this.audit?.record({
      actorId: userId,
      action: 'agent.create',
      resource: saved.name ?? saved.id,
      outcome: 'ok',
      ctx: { id: saved.id, scope: saved.scope },
    });
    return saved;
  }

  async update(id: string, data: Partial<UpsertAgentData>): Promise<Agent> {
    const agent = await this.findById(id);
    if (data.name !== undefined) agent.name = data.name;
    if (data.description !== undefined) agent.description = data.description;
    if (data.systemPrompt !== undefined) agent.systemPrompt = data.systemPrompt;
    if (data.llmConfigId !== undefined) agent.llmConfigId = data.llmConfigId;
    if (data.toolFilter !== undefined) agent.toolFilter = data.toolFilter;
    if (data.maxIterations !== undefined) agent.maxIterations = data.maxIterations;
    if (data.exposeAsTool !== undefined) agent.exposeAsTool = data.exposeAsTool;
    if (data.scope !== undefined) {
      agent.scope = data.scope;
      agent.teamId = data.scope === 'team' ? (data.teamId ?? agent.teamId ?? null) : null;
    }
    return this.repo.save(agent);
  }

  async remove(id: string, actorId?: string): Promise<void> {
    const agent = await this.repo.findOne({ where: { id } });
    await this.repo.delete({ id });
    await this.audit?.record({
      actorId: actorId ?? null,
      action: 'agent.delete',
      resource: agent?.name ?? id,
      outcome: 'ok',
      ctx: { id, scope: agent?.scope },
    });
  }

  // ── Authorization (mirror of flows/custom-tools) ──────────────────────────

  async assertCanManage(
    user: { id: string; role: string },
    scope: AgentScope,
    teamId: string | null | undefined,
    ownerId?: string,
  ): Promise<void> {
    if (scope === 'org') {
      if (user.role !== 'admin') throw new ForbiddenException('agents.agentOrgAdminOnly');
      return;
    }
    if (scope === 'team') {
      if (!teamId) throw new ForbiddenException('agents.teamIdMissing');
      if (user.role === 'admin') return;
      if (await this.teams.isOwner(teamId, user.id)) return;
      throw new ForbiddenException('agents.agentTeamAdminOnly');
    }
    if (ownerId !== undefined && ownerId !== user.id) {
      throw new ForbiddenException('agents.agentOwnerOnly');
    }
  }

  private async assertAccessible(agent: Agent, userId: string): Promise<void> {
    if (agent.userId === userId) return;
    if (agent.scope === 'org') return;
    if (agent.scope === 'team' && agent.teamId && (await this.teams.isMember(agent.teamId, userId))) return;
    throw new ForbiddenException('agents.agentAccessDenied');
  }

  private visibilityWhere(userId: string, teamIds: string[]) {
    const where: any[] = [{ userId }, { scope: 'org' }];
    if (teamIds.length) where.push({ scope: 'team', teamId: In(teamIds) });
    return where;
  }
}
