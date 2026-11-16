// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Plugins (specs/PLUGINS.md): the installed plugins, their settings, events (dedup and log), key-value store, people
 * links and the admin's trusted signing keys; `pluginId` on the primitives a plugin contributes (skills, MCP servers,
 * flows), null for everything that exists today; app_config.pluginsAllowUnsigned (default off).
 *
 * name = 'Plugins1787300000108'
 */
export class Plugins1787300000108 implements MigrationInterface {
  name = 'Plugins1787300000108';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "plugins" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name" varchar(64) NOT NULL UNIQUE,
        "version" varchar(32) NOT NULL,
        "contract" int NOT NULL,
        "manifest" jsonb,
        "pendingManifest" jsonb,
        "status" varchar(20) NOT NULL DEFAULT 'pending_approval',
        "statusDetail" text,
        "scope" varchar(20) NOT NULL DEFAULT 'org',
        "ownerId" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "teamId" uuid,
        "agentId" uuid,
        "trust" varchar(16) NOT NULL DEFAULT 'unsigned',
        "signedBy" varchar(128),
        "sha256" varchar(64) NOT NULL,
        "grants" jsonb,
        "tokenVersion" int NOT NULL DEFAULT 1,
        "approvedBy" uuid,
        "approvedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "plugin_settings" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "pluginId" uuid NOT NULL REFERENCES "plugins"("id") ON DELETE CASCADE,
        "key" varchar(64) NOT NULL,
        "value" text NOT NULL,
        "secret" boolean NOT NULL DEFAULT false,
        UNIQUE ("pluginId", "key")
      )`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "plugin_events" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "pluginId" uuid NOT NULL REFERENCES "plugins"("id") ON DELETE CASCADE,
        "eventId" varchar(128) NOT NULL,
        "type" varchar(64) NOT NULL,
        "at" timestamptz NOT NULL,
        "outcome" varchar(16) NOT NULL,
        "detail" text,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("pluginId", "eventId")
      )`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_plugin_events_plugin_created" ON "plugin_events" ("pluginId", "createdAt")`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "plugin_kv" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "pluginId" uuid NOT NULL REFERENCES "plugins"("id") ON DELETE CASCADE,
        "key" varchar(256) NOT NULL,
        "value" jsonb NOT NULL,
        "bytes" int NOT NULL,
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("pluginId", "key")
      )`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "plugin_identities" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "pluginId" uuid NOT NULL REFERENCES "plugins"("id") ON DELETE CASCADE,
        "externalId" varchar(256) NOT NULL,
        "displayName" varchar(128),
        "userId" uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "authorized" boolean NOT NULL DEFAULT false,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("pluginId", "externalId")
      )`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "plugin_trusted_keys" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "keyId" varchar(128) NOT NULL UNIQUE,
        "level" varchar(16) NOT NULL,
        "publicKey" text NOT NULL,
        "addedBy" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )`);
    for (const table of ['skills', 'mcp_servers', 'flows']) {
      await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "pluginId" uuid`);
      await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_${table}_pluginId" ON "${table}" ("pluginId")`);
    }
    await queryRunner.query(`ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "pluginsAllowUnsigned" boolean NOT NULL DEFAULT false`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "pluginsAllowUnsigned"`);
    for (const table of ['skills', 'mcp_servers', 'flows']) {
      await queryRunner.query(`DROP INDEX IF EXISTS "IDX_${table}_pluginId"`);
      await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "pluginId"`);
    }
    for (const t of ['plugin_trusted_keys', 'plugin_identities', 'plugin_kv', 'plugin_events', 'plugin_settings', 'plugins']) {
      await queryRunner.query(`DROP TABLE IF EXISTS "${t}"`);
    }
  }
}
