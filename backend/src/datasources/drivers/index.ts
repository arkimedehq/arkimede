/**
 * @file drivers/index.ts
 *
 * SQL driver registry: maps engine → driver. This is the only place to touch to
 * add a new relational DBMS (write the driver file and register it here).
 */
import { SqlEngine, isSqlEngine } from '../engine.types';
import { SqlDriver } from './sql-driver.interface';
import { postgresDriver } from './postgres.driver';
import { mysqlDriver, mariadbDriver } from './mysql.driver';
import { mssqlDriver } from './mssql.driver';
import { oracleDriver } from './oracle.driver';
import { sqliteDriver } from './sqlite.driver';

const DRIVERS: Record<SqlEngine, SqlDriver> = {
  postgres: postgresDriver,
  mysql:    mysqlDriver,
  mariadb:  mariadbDriver,
  mssql:    mssqlDriver,
  oracle:   oracleDriver,
  sqlite:   sqliteDriver,
};

/** Returns the driver for the given engine. Throws if the engine is not supported. */
export function getDriver(engine: string): SqlDriver {
  if (!isSqlEngine(engine)) {
    throw new Error(`Engine SQL non supportato: "${engine}".`);
  }
  return DRIVERS[engine];
}

/** Example connection string (scheme) for each engine — used for hints/UI. */
export function engineScheme(engine: SqlEngine): string {
  return DRIVERS[engine].scheme;
}

export * from './sql-driver.interface';
