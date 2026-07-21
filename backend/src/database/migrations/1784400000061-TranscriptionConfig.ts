import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Voice transcription configuration (Whisper), stored in the
 * `app_config` singleton alongside the embedding configuration. Transcription
 * always goes through an OpenAI-compatible `/v1/audio/transcriptions` endpoint
 * (OpenAI cloud, Groq, or a self-hosted whisper) chosen by the admin.
 *
 *   - transcriptionEnabled   — global toggle of the microphone button (default false)
 *   - transcriptionProvider  — 'openai' | 'groq' | 'openai-compatible'
 *   - transcriptionModel     — model name (e.g. whisper-1, whisper-large-v3)
 *   - transcriptionApiKey    — encrypted API key (AES, format "<iv>:<ct>")
 *   - transcriptionBaseUrl   — base URL for self-hosted / compatible providers
 */
export class TranscriptionConfig1784400000061 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(
      `ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "transcriptionEnabled" boolean NOT NULL DEFAULT false`,
    );
    await runner.query(
      `ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "transcriptionProvider" varchar(50) NOT NULL DEFAULT 'openai'`,
    );
    await runner.query(
      `ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "transcriptionModel" varchar(200)`,
    );
    await runner.query(
      `ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "transcriptionApiKey" text`,
    );
    await runner.query(
      `ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "transcriptionBaseUrl" varchar(500)`,
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "transcriptionBaseUrl"`);
    await runner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "transcriptionApiKey"`);
    await runner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "transcriptionModel"`);
    await runner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "transcriptionProvider"`);
    await runner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "transcriptionEnabled"`);
  }
}