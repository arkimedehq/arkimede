/**
 * M6 regression — project-scoped skill endpoints must enforce project access.
 *  - GET /api/skills/project/:projectId (findByProject): only members may list a
 *    project's assigned skills + scripts.
 *  - POST /api/skills/:id/assign/:projectId (assignToProject): the caller must be
 *    able to WRITE the target project, else it could inject a skill (tool) into
 *    another tenant's project context.
 */
import { describe, it, expect, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { SkillsService } from '../../src/skills/skills.service';

function baseService() {
  const svc: any = Object.create(SkillsService.prototype);
  svc.assignmentRepo = {
    find: vi.fn(async () => [{ skill: { id: 's1', status: 'ready' } }]),
    findOne: vi.fn(async () => null),
    create: vi.fn((x: any) => x),
    save: vi.fn(async (x: any) => x),
  };
  return svc;
}

describe('findByProject — project access enforced (M6 read)', () => {
  it('lists skills for a project member', async () => {
    const svc = baseService();
    svc.projectsService = { canAccess: vi.fn(async () => true) };
    const skills = await svc.findByProject('proj-1', 'member');
    expect(skills).toHaveLength(1);
    expect(svc.projectsService.canAccess).toHaveBeenCalledWith('proj-1', 'member');
  });

  it('denies a non-member and reads no assignments', async () => {
    const svc = baseService();
    svc.projectsService = { canAccess: vi.fn(async () => false) };
    await expect(svc.findByProject('proj-1', 'outsider')).rejects.toBeInstanceOf(ForbiddenException);
    expect(svc.assignmentRepo.find).not.toHaveBeenCalled();
  });
});

describe('assignToProject — project write access enforced (M6 write)', () => {
  it('assigns when the caller can write the project', async () => {
    const svc = baseService();
    svc.findOne = vi.fn(async () => ({ id: 's1', status: 'ready', ownerId: 'A' }));
    svc.projectsService = { canWrite: vi.fn(async () => true) };
    await svc.assignToProject('s1', 'proj-1', 'writer');
    expect(svc.projectsService.canWrite).toHaveBeenCalledWith('proj-1', 'writer');
    expect(svc.assignmentRepo.save).toHaveBeenCalled();
  });

  it("denies injecting a skill into a project the caller cannot write", async () => {
    const svc = baseService();
    svc.findOne = vi.fn(async () => ({ id: 's1', status: 'ready', ownerId: 'A' })); // caller owns the skill…
    svc.projectsService = { canWrite: vi.fn(async () => false) };                    // …but not the project
    await expect(svc.assignToProject('s1', 'victim-proj', 'A')).rejects.toBeInstanceOf(ForbiddenException);
    expect(svc.assignmentRepo.save).not.toHaveBeenCalled();
  });
});
