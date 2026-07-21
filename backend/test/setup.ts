/**
 * Global test setup.
 *
 * `reflect-metadata` must be imported exactly once before any module that
 * uses decorators (Nest `@Injectable`, TypeORM `@Entity`/`@Column`): without it,
 * importing those modules in the tests would fail.
 */
import 'reflect-metadata';

// JWT_SECRET is fail-fast in production (>=32 chars): we provide a test value
// so that the modules that consume it (auth/files/mcp/notifications) are
// instantiable under test. We do not touch TOOL_SECRETS_KEY: the crypto tests
// manipulate it explicitly to verify its fail-fast behavior.
process.env.JWT_SECRET ||= 'test-jwt-secret-'.padEnd(48, 'x');

// RUN_TOKEN_SECRET signs the internal run tokens (mintRunToken): the skill-tool
// factory mints one on every execution, so unit tests that build a skill tool
// need a signing secret configured (any non-empty value works — it is only an
// HMAC key).
process.env.RUN_TOKEN_SECRET ||= 'test-run-token-secret';
