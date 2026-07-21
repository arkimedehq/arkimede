import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `engine` column to data_sources: the concrete DBMS
 * (postgres | mysql | mariadb | mssql | oracle | sqlite) that selects the driver.
 * Previously the engine was inferred from the connection string prefix (pg/mysql only);
 * now it is explicit.
 *
 * Existing rows get the 'postgres' default. The connection string is encrypted
 * (impossible to deduce the dialect in SQL): any pre-existing MySQL DataSources
 * must be updated by setting the correct engine from the UI.
 *
 * name = 'DataSourceEngine1784100000060'
 */
export class DataSourceEngine1784100000060 implements MigrationInterface {
  name = 'DataSourceEngine1784100000060';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS "engine" varchar(20) NOT NULL DEFAULT 'postgres'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE data_sources DROP COLUMN IF EXISTS "engine"`);
  }
}
