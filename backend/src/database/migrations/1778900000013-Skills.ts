import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: Skills system.
 *
 * Creates:
 *   skills                    — skill definition (metadata + installation status)
 *   skill_scripts             — executable scripts declared in skill.yaml
 *   skill_project_assignments — assignment of skills to specific projects
 *
 * Enums created:
 *   skills_status_enum              — pending | installing | ready | error
 *   skills_scope_enum               — personal | shared
 *   skill_scripts_language_enum     — python | javascript
 *
 * Indexes for frequent queries:
 *   - skill by owner + status   (tool loading per user)
 *   - skill shared approved     (public browse)
 *   - script by skill           (LangGraph tool generation)
 *   - assignments by project    (tool loading per project)
 */
export class Skills1778900000013 implements MigrationInterface {
  name = 'Skills1778900000013';

  public async up(queryRunner: QueryRunner): Promise<void> {

    // ─── Enum types ──────────────────────────────────────────────────────────

    await queryRunner.query(`
      CREATE TYPE "public"."skills_status_enum"
      AS ENUM('pending', 'installing', 'ready', 'error')
    `);

    await queryRunner.query(`
      CREATE TYPE "public"."skills_scope_enum"
      AS ENUM('personal', 'shared')
    `);

    await queryRunner.query(`
      CREATE TYPE "public"."skill_scripts_language_enum"
      AS ENUM('python', 'javascript')
    `);

    // ─── skills ──────────────────────────────────────────────────────────────

    await queryRunner.query(`
      CREATE TABLE "skills" (
        "id"          uuid            NOT NULL DEFAULT uuid_generate_v4(),
        "ownerId"     uuid            NOT NULL,
        "name"        varchar(64)     NOT NULL,
        "version"     varchar(32)     NOT NULL DEFAULT '1.0.0',
        "description" text            NOT NULL,
        "author"      varchar(256)    NULL,
        "license"     varchar(64)     NULL,
        "status"      "public"."skills_status_enum"  NOT NULL DEFAULT 'pending',
        "installLog"  text            NULL,
        "scope"       "public"."skills_scope_enum"   NOT NULL DEFAULT 'personal',
        "isApproved"  boolean         NOT NULL DEFAULT false,
        "packagePath" varchar(512)    NULL,
        "pythonDeps"  jsonb           NOT NULL DEFAULT '[]',
        "jsDeps"      jsonb           NOT NULL DEFAULT '[]',
        "createdAt"   TIMESTAMP       NOT NULL DEFAULT now(),
        "updatedAt"   TIMESTAMP       NOT NULL DEFAULT now(),
        CONSTRAINT "PK_skills" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_skills_owner_name" UNIQUE ("ownerId", "name")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "skills"
      ADD CONSTRAINT "FK_skills_owner"
      FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE
    `);

    // Main index: all skills of a user filtered by status
    await queryRunner.query(`
      CREATE INDEX "IDX_skills_owner_status"
      ON "skills" ("ownerId", "status")
    `);

    // Index for browsing approved public skills
    await queryRunner.query(`
      CREATE INDEX "IDX_skills_scope_approved"
      ON "skills" ("scope", "isApproved")
      WHERE "scope" = 'shared'
    `);

    // Partial unique index: no name duplicates among shared skills (global namespace)
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_skills_shared_name"
      ON "skills" ("name")
      WHERE "scope" = 'shared'
    `);

    // ─── skill_scripts ────────────────────────────────────────────────────────

    await queryRunner.query(`
      CREATE TABLE "skill_scripts" (
        "id"          uuid         NOT NULL DEFAULT uuid_generate_v4(),
        "skillId"     uuid         NOT NULL,
        "filename"    varchar(256) NOT NULL,
        "language"    "public"."skill_scripts_language_enum" NOT NULL,
        "description" text         NOT NULL,
        "inputSchema" jsonb        NOT NULL DEFAULT '{"type":"object","properties":{}}',
        CONSTRAINT "PK_skill_scripts" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "skill_scripts"
      ADD CONSTRAINT "FK_skill_scripts_skill"
      FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE CASCADE
    `);

    // Index to load all scripts of a skill in a single query
    await queryRunner.query(`
      CREATE INDEX "IDX_skill_scripts_skill"
      ON "skill_scripts" ("skillId")
    `);

    // ─── skill_project_assignments ────────────────────────────────────────────

    await queryRunner.query(`
      CREATE TABLE "skill_project_assignments" (
        "id"           uuid      NOT NULL DEFAULT uuid_generate_v4(),
        "skillId"      uuid      NOT NULL,
        "projectId"    uuid      NOT NULL,
        "assignedById" uuid      NULL,
        "assignedAt"   TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_skill_project_assignments" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_skill_project" UNIQUE ("skillId", "projectId")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "skill_project_assignments"
      ADD CONSTRAINT "FK_spa_skill"
      FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE CASCADE
    `);

    await queryRunner.query(`
      ALTER TABLE "skill_project_assignments"
      ADD CONSTRAINT "FK_spa_project"
      FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE
    `);

    await queryRunner.query(`
      ALTER TABLE "skill_project_assignments"
      ADD CONSTRAINT "FK_spa_assigned_by"
      FOREIGN KEY ("assignedById") REFERENCES "users"("id") ON DELETE SET NULL
    `);

    // Index for frequent query: all skills assigned to a project
    await queryRunner.query(`
      CREATE INDEX "IDX_spa_project"
      ON "skill_project_assignments" ("projectId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Removal in reverse order relative to up() (dependent tables first)
    await queryRunner.query(`DROP INDEX "IDX_spa_project"`);
    await queryRunner.query(`ALTER TABLE "skill_project_assignments" DROP CONSTRAINT "FK_spa_assigned_by"`);
    await queryRunner.query(`ALTER TABLE "skill_project_assignments" DROP CONSTRAINT "FK_spa_project"`);
    await queryRunner.query(`ALTER TABLE "skill_project_assignments" DROP CONSTRAINT "FK_spa_skill"`);
    await queryRunner.query(`DROP TABLE "skill_project_assignments"`);

    await queryRunner.query(`DROP INDEX "IDX_skill_scripts_skill"`);
    await queryRunner.query(`ALTER TABLE "skill_scripts" DROP CONSTRAINT "FK_skill_scripts_skill"`);
    await queryRunner.query(`DROP TABLE "skill_scripts"`);

    await queryRunner.query(`DROP INDEX "UQ_skills_shared_name"`);
    await queryRunner.query(`DROP INDEX "IDX_skills_scope_approved"`);
    await queryRunner.query(`DROP INDEX "IDX_skills_owner_status"`);
    await queryRunner.query(`ALTER TABLE "skills" DROP CONSTRAINT "FK_skills_owner"`);
    await queryRunner.query(`DROP TABLE "skills"`);

    await queryRunner.query(`DROP TYPE "public"."skill_scripts_language_enum"`);
    await queryRunner.query(`DROP TYPE "public"."skills_scope_enum"`);
    await queryRunner.query(`DROP TYPE "public"."skills_status_enum"`);
  }
}
