/**
 * @file security.util.ts
 *
 * Fail-fast security validations to run at bootstrap (`main.ts`),
 * so that the app does not start at all with a weak/insecure configuration.
 */

/**
 * Known placeholders (and now public, since the repo is open source): a JWT signed
 * with one of these would be forgeable by anyone → we reject them explicitly.
 */
const WEAK_JWT_SECRETS = new Set([
  'arkimede-secret-key',
  'cambia-questo-segreto-in-produzione',
  'changeme',
  'change-me',
  'secret',
  'your-secret',
]);

const MIN_JWT_SECRET_LEN = 32;

/**
 * Validates `JWT_SECRET` at startup (fail-fast). Rejects secrets that are absent, too
 * short or matching a known placeholder. No fallback: if it is missing, the app
 * does not start (same principle as `assertEncryptionKey` for TOOL_SECRETS_KEY).
 */
export function assertJwtSecret(): void {
  const raw = (process.env.JWT_SECRET ?? '').trim();
  if (raw.length < MIN_JWT_SECRET_LEN || WEAK_JWT_SECRETS.has(raw)) {
    throw new Error(
      `JWT_SECRET missing or too weak: expected at least ${MIN_JWT_SECRET_LEN} random characters, not a placeholder. Generate with \`openssl rand -hex 32\`.`,
    );
  }
}