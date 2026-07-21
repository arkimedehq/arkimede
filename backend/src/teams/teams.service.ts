import {
  Injectable, NotFoundException, ConflictException, BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Team } from './team.entity';
import { TeamMembership, TeamRole } from './team-membership.entity';

export interface TeamWithCount extends Team {
  memberCount: number;
}

@Injectable()
export class TeamsService {
  constructor(
    @InjectRepository(Team) private readonly teams: Repository<Team>,
    @InjectRepository(TeamMembership) private readonly memberships: Repository<TeamMembership>,
  ) {}

  // ── Team CRUD ────────────────────────────────────────────────────────────

  async list(): Promise<TeamWithCount[]> {
    const teams = await this.teams.find({ order: { name: 'ASC' } });
    const counts = await this.memberships
      .createQueryBuilder('m')
      .select('m.teamId', 'teamId')
      .addSelect('COUNT(*)', 'count')
      .groupBy('m.teamId')
      .getRawMany<{ teamId: string; count: string }>();
    const byTeam = new Map(counts.map((c) => [c.teamId, parseInt(c.count, 10)]));
    return teams.map((t) => ({ ...t, memberCount: byTeam.get(t.id) ?? 0 }));
  }

  async getById(id: string): Promise<Team> {
    const team = await this.teams.findOne({ where: { id } });
    if (!team) throw new NotFoundException('teams.notFound');
    return team;
  }

  async create(data: { name: string; description?: string | null; color?: string | null }): Promise<Team> {
    const existing = await this.teams.findOne({ where: { name: data.name } });
    if (existing) throw new ConflictException('teams.nameTaken');
    return this.teams.save(this.teams.create({
      name: data.name,
      description: data.description ?? null,
      color: data.color ?? null,
    }));
  }

  async update(id: string, data: { name?: string; description?: string | null; color?: string | null }): Promise<Team> {
    const team = await this.getById(id);
    if (data.name && data.name !== team.name) {
      const conflict = await this.teams.findOne({ where: { name: data.name } });
      if (conflict) throw new ConflictException('teams.nameTaken');
      team.name = data.name;
    }
    if (data.description !== undefined) team.description = data.description ?? null;
    if (data.color       !== undefined) team.color       = data.color ?? null;
    return this.teams.save(team);
  }

  async remove(id: string): Promise<void> {
    const team = await this.getById(id);
    // Memberships are removed via ON DELETE CASCADE.
    await this.teams.remove(team);
  }

  // ── Members ───────────────────────────────────────────────────────────────

  async listMembers(teamId: string): Promise<TeamMembership[]> {
    await this.getById(teamId);
    return this.memberships.find({
      where: { teamId },
      relations: { user: true },
      order: { createdAt: 'ASC' },
    });
  }

  async addMember(teamId: string, userId: string, role: TeamRole = 'member'): Promise<TeamMembership> {
    await this.getById(teamId);
    const existing = await this.memberships.findOne({ where: { teamId, userId } });
    if (existing) throw new ConflictException('teams.memberAlreadyExists');
    return this.memberships.save(this.memberships.create({ teamId, userId, role }));
  }

  async setMemberRole(teamId: string, userId: string, role: TeamRole): Promise<TeamMembership> {
    const m = await this.memberships.findOne({ where: { teamId, userId } });
    if (!m) throw new NotFoundException('teams.memberNotFound');
    if (m.role === 'owner' && role !== 'owner') await this.assertNotLastOwner(teamId, userId);
    m.role = role;
    return this.memberships.save(m);
  }

  async removeMember(teamId: string, userId: string): Promise<void> {
    const m = await this.memberships.findOne({ where: { teamId, userId } });
    if (!m) throw new NotFoundException('teams.memberNotFound');
    if (m.role === 'owner') await this.assertNotLastOwner(teamId, userId);
    await this.memberships.remove(m);
  }

  /** Teams a user belongs to (for resource scoping and the "my teams" UI). */
  async teamsForUser(userId: string): Promise<Team[]> {
    const ms = await this.memberships.find({
      where: { userId },
      relations: { team: true },
    });
    return ms.map((m) => m.team);
  }

  /** IDs of a user's teams (lightweight helper for visibility queries). */
  async teamIdsForUser(userId: string): Promise<string[]> {
    const ms = await this.memberships.find({ where: { userId }, select: { teamId: true } });
    return ms.map((m) => m.teamId);
  }

  async isMember(teamId: string, userId: string): Promise<boolean> {
    return (await this.memberships.count({ where: { teamId, userId } })) > 0;
  }

  /** True if the user is a team owner (can manage the team's team-scoped resources). */
  async isOwner(teamId: string, userId: string): Promise<boolean> {
    return (await this.memberships.count({ where: { teamId, userId, role: 'owner' } })) > 0;
  }

  private async assertNotLastOwner(teamId: string, excludeUserId: string): Promise<void> {
    const others = await this.memberships
      .createQueryBuilder('m')
      .where('m.teamId = :teamId', { teamId })
      .andWhere('m.role = :role', { role: 'owner' })
      .andWhere('m.userId != :userId', { userId: excludeUserId })
      .getCount();
    if (others === 0) {
      throw new BadRequestException('teams.lastOwner');
    }
  }
}
