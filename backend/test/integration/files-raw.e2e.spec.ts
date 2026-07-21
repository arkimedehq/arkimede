/**
 * T3/B1 — e2e of the download `GET /api/files/raw?rel=`:
 *   - relative paths only (no absolute), containment via realpath (anti ../ and symlink);
 *   - access-aware (C2): a tracked file is served only to those who can access it.
 *
 * Replaces scripts/smoke-fileraw.ts, which called the old serveRaw signature
 * (pre access-aware) and no longer exercised the real check.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { startTestDb, type TestDb } from './_db';
import { FilesController } from '../../src/files/files.controller';
import { FilesService } from '../../src/files/files.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { File as FileEntity } from '../../src/files/files.entity';
import { Project } from '../../src/projects/projects.entity';
import { ProjectTeam } from '../../src/projects/project-team.entity';
import { Message } from '../../src/messages/messages.entity';
import { User } from '../../src/users/users.entity';
import { JwtAuthGuard } from '../../src/common/guards/jwt-auth.guard';
import { JwtService } from '@nestjs/jwt';
import { DataSourcesService } from '../../src/datasources/datasources.service';

const teamsStub = { teamIdsForUser: async () => [], getById: async (id: string) => ({ id }) } as any;

let db: TestDb;
let app: INestApplication;
let current: { id: string; role: string };
let root: string, uploadDir: string, outDir: string;
let BID: string, CID: string;
const savedEnv = { up: process.env.UPLOAD_DIR, out: process.env.SKILLS_OUTPUT_DIR };

beforeAll(async () => {
  // On-disk layout: uploads/ (root) + uploads/skills-output/ + a "secret" file OUTSIDE
  root = mkdtempSync(join(tmpdir(), 'pa-fileraw-'));
  uploadDir = join(root, 'uploads');
  outDir = join(uploadDir, 'skills-output');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(uploadDir, 'owner.txt'), 'owner-content');
  writeFileSync(join(outDir, 'out.pdf'), 'pdf-untracked');
  writeFileSync(join(root, 'secret.txt'), 'TOP SECRET');               // outside the root
  symlinkSync(join(root, 'secret.txt'), join(uploadDir, 'evil'));       // symlink escaping out
  process.env.UPLOAD_DIR = uploadDir;
  process.env.SKILLS_OUTPUT_DIR = outDir;

  db = await startTestDb();
  const cfgStub = { get: (k: string, d?: any) => (k === 'UPLOAD_DIR' ? uploadDir : k === 'ANTHROPIC_API_KEY' ? 'sk-test' : d) } as any;
  const projects = new ProjectsService(db.dataSource.getRepository(Project), db.dataSource.getRepository(ProjectTeam), teamsStub);
  const fileRepo = db.dataSource.getRepository(FileEntity);
  const service = new FilesService(fileRepo, db.dataSource.getRepository(Message), cfgStub, projects, teamsStub);

  const users = db.dataSource.getRepository(User);
  const mk = async (email: string) => (await users.save(users.create({ email, name: email, password: 'x' }))).id;
  BID = await mk('b@raw.local');
  CID = await mk('c@raw.local');

  // owner.txt is a TRACKED file owned by B (personal scope). Store the storagePath in
  // its realpath form: the controller resolves the requested path via realpathSync, and
  // on macOS the temp dir sits under /var → /private/var, so a non-resolved storagePath
  // would never match the exact-path lookup and the file would look untracked.
  await fileRepo.save(fileRepo.create({
    originalName: 'owner.txt', storagePath: join(realpathSync(uploadDir), 'owner.txt'),
    mimeType: 'text/plain', size: 13, userId: BID, scope: 'personal',
  }));

  const moduleRef = await Test.createTestingModule({
    controllers: [FilesController],
    providers: [
      { provide: FilesService, useValue: service },
      // FilesController also injects JwtService (?token= streaming) and
      // DataSourcesService (file-share sources); the raw ?rel= tests don't
      // exercise them, so minimal mocks satisfy DI.
      { provide: JwtService, useValue: { verify: () => ({}), sign: () => '' } },
      { provide: DataSourcesService, useValue: {} },
    ],
  })
    .overrideGuard(JwtAuthGuard)
    .useValue({ canActivate: (ctx: any) => { ctx.switchToHttp().getRequest().user = current; return true; } })
    .compile();

  app = moduleRef.createNestApplication();
  await app.init();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await db?.stop();
  rmSync(root, { recursive: true, force: true });
  process.env.UPLOAD_DIR = savedEnv.up;
  process.env.SKILLS_OUTPUT_DIR = savedEnv.out;
});

const raw = (rel: string) => request(app.getHttpServer()).get('/api/files/raw').query({ rel });

describe('path containment (B1)', () => {
  it('serves a legitimate file under the root', async () => {
    current = { id: BID, role: 'user' };
    const res = await raw('owner.txt');
    expect(res.status).toBe(200);
  });

  it('rejects the absolute path (400)', async () => {
    current = { id: BID, role: 'user' };
    expect((await raw('/etc/passwd')).status).toBe(400);
  });

  it('rejects traversal outside the root (404)', async () => {
    current = { id: BID, role: 'user' };
    expect((await raw('../secret.txt')).status).toBe(404);
  });

  it('rejects the symlink that escapes the root (404)', async () => {
    current = { id: BID, role: 'user' };
    expect((await raw('evil')).status).toBe(404);
  });

  it('rejects the nonexistent file (404) and the missing rel (400)', async () => {
    current = { id: BID, role: 'user' };
    expect((await raw('nope.txt')).status).toBe(404);
    expect((await request(app.getHttpServer()).get('/api/files/raw')).status).toBe(400);
  });
});

describe('access-aware (C2)', () => {
  it('another user CANNOT download someone else\'s tracked file (403)', async () => {
    current = { id: CID, role: 'user' };
    expect((await raw('owner.txt')).status).toBe(403);
  });

  it('an untracked output is served with path containment only', async () => {
    current = { id: CID, role: 'user' };
    expect((await raw('skills-output/out.pdf')).status).toBe(200);
  });
});
