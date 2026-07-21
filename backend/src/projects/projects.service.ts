import {
  Injectable, NotFoundException, ForbiddenException,
  ConflictException, BadRequestException, Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, Brackets } from 'typeorm';
import { Project } from './projects.entity';
import { ProjectTeam, ProjectTeamRole } from './project-team.entity';
import { TeamsService } from '../teams/teams.service';
import { AuditService } from '../audit/audit.service';

/**
 * A user's access level on a project:
 *   owner        → project creator (manages sharing and settings)
 *   collaborator → member of a team assigned as collaborator (works fully)
 *   viewer       → member of a team assigned as viewer (read-only)
 *   null         → no access
 *
 * NB: the global admin does NOT appear here — their authority is only *management*
 * (assertCanManage in the controller), not access to the project's work/context.
 * This keeps the chat/file cascade simple and membership-based.
 */
export type ProjectAccessRole = 'owner' | 'collaborator' | 'viewer';

@Injectable()
export class ProjectsService {
  constructor(
    @InjectRepository(Project)     private readonly repo:   Repository<Project>,
    @InjectRepository(ProjectTeam) private readonly ptRepo: Repository<ProjectTeam>,
    private readonly teams: TeamsService,
    @Optional() private readonly audit?: AuditService,
  ) {}

  // ── Visibility ─────────────────────────────────────────────────────────────

  /** Projects visible to the user: own (owner) + shared with their teams. */
  async findAllForUser(userId: string): Promise<Project[]> {
    const teamIds = await this.teams.teamIdsForUser(userId);
    const qb = this.repo.createQueryBuilder('p')
      .leftJoinAndSelect('p.chats', 'chats')
      .leftJoinAndSelect('p.files', 'files')
      .orderBy('p.updatedAt', 'DESC');

    if (teamIds.length) {
      qb.where(new Brackets((b) => {
        b.where('p.userId = :userId', { userId })
         .orWhere(
           'p.id IN (SELECT pt."projectId" FROM project_teams pt WHERE pt."teamId" IN (:...teamIds))',
           { teamIds },
         );
      }));
    } else {
      qb.where('p.userId = :userId', { userId });
    }
    return qb.getMany();
  }

  /**
   * The user's access level on the project (owner/collaborator/viewer/null),
   * based ONLY on ownership + membership of the assigned teams. Used by the
   * visibility cascade on chats and files.
   */
  async accessLevel(projectId: string, userId: string): Promise<ProjectAccessRole | null> {
    const project = await this.repo.findOne({ where: { id: projectId }, select: { id: true, userId: true } });
    if (!project) return null;
    if (project.userId && project.userId === userId) return 'owner';

    const teamIds = await this.teams.teamIdsForUser(userId);
    if (!teamIds.length) return null;

    const assignments = await this.ptRepo.find({ where: { projectId, teamId: In(teamIds) } });
    if (!assignments.length) return null;
    return assignments.some((a) => a.role === 'collaborator') ? 'collaborator' : 'viewer';
  }

  /** True if the user can see the project (any role). */
  async canAccess(projectId: string, userId: string): Promise<boolean> {
    return (await this.accessLevel(projectId, userId)) !== null;
  }

  /** True if the user can write in the project (owner or collaborator, not viewer). */
  async canWrite(projectId: string, userId: string): Promise<boolean> {
    const lvl = await this.accessLevel(projectId, userId);
    return lvl === 'owner' || lvl === 'collaborator';
  }

  async findOne(id: string, userId: string, userRole?: string): Promise<Project> {
    const project = await this.repo.findOne({ where: { id }, relations: ['chats', 'files'] });
    if (!project) throw new NotFoundException('projects.notFound');
    if (userRole === 'admin') return project;
    if (!(await this.canAccess(id, userId))) throw new ForbiddenException();
    return project;
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────

  async create(userId: string, data: Partial<Project>) {
    const project = await this.repo.save(this.repo.create({ ...data, userId }));
    await this.audit?.record({
      actorId: userId,
      action: 'project.create',
      resource: project.name ?? project.id,
      outcome: 'ok',
      ctx: { projectId: project.id },
    });
    return project;
  }

  async update(id: string, userId: string, userRole: string, data: Partial<Project>) {
    await this.assertCanManage(id, userId, userRole);
    await this.repo.update(id, data);
    return this.repo.findOne({ where: { id } });
  }

  async remove(id: string, userId: string, userRole: string) {
    await this.assertCanManage(id, userId, userRole);
    await this.repo.delete(id);
    await this.audit?.record({
      actorId: userId,
      action: 'project.delete',
      resource: id,
      outcome: 'ok',
      ctx: { projectId: id },
    });
    return { deleted: true };
  }

  // ── Sharing with teams ────────────────────────────────────────────────

  /** Teams assigned to the project (with team data). Requires access to the project. */
  async listTeams(projectId: string, userId: string, userRole: string): Promise<ProjectTeam[]> {
    if (userRole !== 'admin' && !(await this.canAccess(projectId, userId))) {
      throw new ForbiddenException();
    }
    return this.ptRepo.find({
      where: { projectId },
      relations: { team: true },
      order: { addedAt: 'ASC' },
    });
  }

  async addTeam(
    projectId: string, userId: string, userRole: string,
    teamId: string, role: ProjectTeamRole = 'collaborator',
  ): Promise<ProjectTeam> {
    await this.assertCanManage(projectId, userId, userRole);
    this.assertValidRole(role);
    await this.teams.getById(teamId); // 404 if the team doesn't exist
    const existing = await this.ptRepo.findOne({ where: { projectId, teamId } });
    if (existing) throw new ConflictException('projects.teamAlreadyAssigned');
    const pt = await this.ptRepo.save(this.ptRepo.create({ projectId, teamId, role }));
    await this.audit?.record({
      actorId: userId,
      action: 'project.share',
      resource: projectId,
      outcome: 'ok',
      ctx: { projectId, teamId, role },
    });
    return pt;
  }

  async setTeamRole(
    projectId: string, userId: string, userRole: string,
    teamId: string, role: ProjectTeamRole,
  ): Promise<ProjectTeam> {
    await this.assertCanManage(projectId, userId, userRole);
    this.assertValidRole(role);
    const pt = await this.ptRepo.findOne({ where: { projectId, teamId } });
    if (!pt) throw new NotFoundException('projects.teamNotAssigned');
    pt.role = role;
    return this.ptRepo.save(pt);
  }

  async removeTeam(projectId: string, userId: string, userRole: string, teamId: string): Promise<void> {
    await this.assertCanManage(projectId, userId, userRole);
    const pt = await this.ptRepo.findOne({ where: { projectId, teamId } });
    if (!pt) throw new NotFoundException('projects.teamNotAssigned');
    await this.ptRepo.remove(pt);
  }

  // ── Authorization helpers ───────────────────────────────────────────────

  /** Project management (settings + sharing): only owner or global admin. */
  private async assertCanManage(projectId: string, userId: string, userRole: string): Promise<void> {
    if (userRole === 'admin') return;
    const project = await this.repo.findOne({ where: { id: projectId }, select: { id: true, userId: true } });
    if (!project) throw new NotFoundException('projects.notFound');
    if (project.userId !== userId) {
      throw new ForbiddenException('projects.onlyOwner');
    }
  }

  private assertValidRole(role: ProjectTeamRole): void {
    if (role !== 'collaborator' && role !== 'viewer') {
      throw new BadRequestException('projects.invalidRole');
    }
  }
}
