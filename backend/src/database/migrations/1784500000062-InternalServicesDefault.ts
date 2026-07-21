import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes the app's internal services (embedding-service and whisper-service) the
 * DEFAULT providers, auto-configured via env + /v1/models probe.
 *
 *   - app_config.embeddingProvider     default → 'internal'
 *   - app_config.transcriptionProvider default → 'internal'
 *   - app_config.transcriptionEnabled  default → true
 *
 * Also updates the singleton row ONLY if it is still at the non-customized default:
 *   - embedding: was 'lmstudio' without baseUrl (pre-existing default intact)
 *   - transcription: columns just introduced (TranscriptionConfig), never touched
 *
 * Note: the internal model mxbai-embed-large-v1 is 1024 dim = same default as
 * embeddingVectorSize, so existing Qdrant collections remain valid.
 */
export class InternalServicesDefault1784500000062 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    // New column defaults
    await runner.query(`ALTER TABLE "app_config" ALTER COLUMN "embeddingProvider" SET DEFAULT 'internal'`);
    await runner.query(`ALTER TABLE "app_config" ALTER COLUMN "transcriptionProvider" SET DEFAULT 'internal'`);
    await runner.query(`ALTER TABLE "app_config" ALTER COLUMN "transcriptionEnabled" SET DEFAULT true`);

    // Migrate the singleton row if intact (does not overwrite real configurations)
    await runner.query(
      `UPDATE "app_config"
         SET "embeddingProvider" = 'internal'
       WHERE "embeddingProvider" = 'lmstudio' AND "embeddingBaseUrl" IS NULL`,
    );
    await runner.query(
      `UPDATE "app_config"
         SET "transcriptionProvider" = 'internal', "transcriptionEnabled" = true
       WHERE "transcriptionProvider" = 'openai' AND "transcriptionApiKey" IS NULL AND "transcriptionBaseUrl" IS NULL`,
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE "app_config" ALTER COLUMN "embeddingProvider" SET DEFAULT 'lmstudio'`);
    await runner.query(`ALTER TABLE "app_config" ALTER COLUMN "transcriptionProvider" SET DEFAULT 'openai'`);
    await runner.query(`ALTER TABLE "app_config" ALTER COLUMN "transcriptionEnabled" SET DEFAULT false`);
  }
}
