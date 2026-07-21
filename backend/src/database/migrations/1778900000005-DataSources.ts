import { MigrationInterface, QueryRunner } from 'typeorm';

export class DataSources1778900000005 implements MigrationInterface {
  name = 'DataSources1778900000005';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "public"."data_sources_scope_enum"
      AS ENUM('personal', 'shared')
    `);

    await queryRunner.query(`
      CREATE TABLE "data_sources" (
        "id"                        uuid         NOT NULL DEFAULT uuid_generate_v4(),
        "userId"                    uuid         NOT NULL,
        "name"                      varchar(100) NOT NULL,
        "description"               text,
        "encryptedConnectionString" text         NOT NULL,
        "schemaHints"               text,
        "prefetchRelations"         boolean      NOT NULL DEFAULT false,
        "scope"  "public"."data_sources_scope_enum" NOT NULL DEFAULT 'personal',
        "createdAt"                 TIMESTAMP    NOT NULL DEFAULT now(),
        "updatedAt"                 TIMESTAMP    NOT NULL DEFAULT now(),
        CONSTRAINT "PK_data_sources" PRIMARY KEY ("id"),
        CONSTRAINT "FK_data_sources_user"
          FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_data_sources_userId" ON "data_sources" ("userId")`);
    await queryRunner.query(`CREATE INDEX "IDX_data_sources_scope"  ON "data_sources" ("scope")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "data_sources"`);
    await queryRunner.query(`DROP TYPE "public"."data_sources_scope_enum"`);
  }
}
