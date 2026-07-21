// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file registry.service.ts
 *
 * Service for the public skill registry (GitHub-based).
 *
 * Responsibilities:
 *   1. Fetch and cache the registry.json index from the GitHub repository
 *   2. Download the ZIP packages for installation
 *   3. Validate the source domain (whitelist)
 *
 * Configuration (.env):
 *   SKILLS_REGISTRY_URL   — URL of registry.json
 *                           Default: official GitHub registry
 *   SKILLS_REGISTRY_CACHE_TTL_MS — cache TTL in ms (default: 300000 = 5 min)
 *
 * The cache is in-memory for simplicity. In production with multiple instances
 * it can be replaced with Redis without changing the interface.
 */
import { Injectable, Logger, ForbiddenException, BadGatewayException } from '@nestjs/common';
import { I18nContext } from 'nestjs-i18n';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { RegistryIndex, RegistrySkill } from './registry.types';

/** URL of the official registry — points to the raw file in the public GitHub repo */
const OFFICIAL_REGISTRY_URL =
  'https://raw.githubusercontent.com/arkimedehq/arkimede-skills/main/registry.json';

/**
 * Verifies the integrity of the downloaded skill package (E3) — PURE, testable function.
 *
 * - declared checksum → mandatory SHA-256 comparison (mismatch = throw).
 * - missing checksum  → blocked if `strict`; otherwise allowed ONLY for admins
 *                       (explicit confirmation of installing an unverified package).
 *
 * Integrity ≠ security: the checksum guarantees "what the registry published",
 * not that the code is harmless (that is contained by sandbox/egress/capability).
 */
export function assertSkillIntegrity(
  buffer: Buffer,
  expectedChecksum: string | undefined,
  opts: { isAdmin: boolean; strict: boolean },
): void {
  if (expectedChecksum) {
    const actual   = createHash('sha256').update(buffer).digest('hex').toLowerCase();
    const expected = expectedChecksum.replace(/^sha256:/i, '').trim().toLowerCase();
    if (actual !== expected) {
      throw new ForbiddenException(
        I18nContext.current()?.t('skills.checksumMismatch', { args: { expected: expected.slice(0, 12), actual: actual.slice(0, 12) } })
        ?? `Checksum mismatch (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…): package tampered with or different from the published one.`,
      );
    }
    return;
  }
  if (opts.strict) {
    throw new ForbiddenException('skills.checksumMissingStrict');
  }
  if (!opts.isAdmin) {
    throw new ForbiddenException('skills.checksumMissingAdminOnly');
  }
}

@Injectable()
export class RegistryService {
  private readonly logger = new Logger(RegistryService.name);

  private readonly registryUrl:  string;
  private readonly cacheTtlMs:   number;

  /** In-memory cache of the index */
  private cache: { data: RegistryIndex; fetchedAt: number } | null = null;

  constructor(private readonly config: ConfigService) {
    this.registryUrl = config.get<string>('SKILLS_REGISTRY_URL', OFFICIAL_REGISTRY_URL);
    this.cacheTtlMs  = parseInt(
      config.get<string>('SKILLS_REGISTRY_CACHE_TTL_MS', '300000'), 10,
    );
  }

  /**
   * Returns the registry index.
   * Uses the in-memory cache if fresh (configurable TTL, default 5 min).
   * On a network error, returns the stale cache if available.
   */
  async fetchIndex(): Promise<RegistryIndex> {
    const now = Date.now();

    if (this.cache && (now - this.cache.fetchedAt) < this.cacheTtlMs) {
      return this.cache.data;
    }

    try {
      const res = await fetch(this.registryUrl, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Arkimede/1.0' },
        signal:  AbortSignal.timeout(10_000), // 10s timeout
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const data = await res.json() as RegistryIndex;

      if (!data.skills || !Array.isArray(data.skills)) {
        throw new Error('registry.json malformed: "skills" field missing or not an array');
      }

      this.cache = { data, fetchedAt: now };
      this.logger.log(`Registry updated: ${data.skills.length} skills (${this.registryUrl})`);
      return data;

    } catch (err: any) {
      // If there is a stale cache, return it with a warning
      if (this.cache) {
        const ageMin = Math.round((now - this.cache.fetchedAt) / 60_000);
        this.logger.warn(
          `Registry unreachable (${err.message}) — using stale cache (${ageMin} min)`,
        );
        return this.cache.data;
      }

      this.logger.error(`Registry unreachable and no cache available: ${err.message}`);
      throw new BadGatewayException(
        I18nContext.current()?.t('skills.registryUnreachable', { args: { message: err.message } })
        ?? `The public registry is unreachable: ${err.message}. Check SKILLS_REGISTRY_URL and the server's network connection.`,
      );
    }
  }

  /**
   * Downloads the ZIP of a skill from the registry.
   *
   * Security: verifies that the downloadUrl domain is in the whitelist
   * (same domain as the registry or raw.githubusercontent.com/github.com).
   * This prevents a malicious registry from redirecting to arbitrary downloads.
   */
  async downloadZip(downloadUrl: string): Promise<Buffer> {
    this.validateDownloadUrl(downloadUrl);

    this.logger.log(`Downloading skill from: ${downloadUrl}`);

    try {
      const res = await fetch(downloadUrl, {
        headers: { 'User-Agent': 'Arkimede/1.0' },
        signal:  AbortSignal.timeout(120_000), // 2 min for large ZIPs
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const buffer = await res.arrayBuffer();
      return Buffer.from(buffer);

    } catch (err: any) {
      throw new BadGatewayException(
        I18nContext.current()?.t('skills.downloadFailed', { args: { message: err.message } })
        ?? `Download failed: ${err.message}`,
      );
    }
  }

  /**
   * Downloads and VERIFIES the integrity of the package (E3): looks up the checksum declared
   * in the registry for the downloadUrl, then applies `assertSkillIntegrity`.
   * `isAdmin` allows installing skills without a checksum (admin confirmation).
   */
  async downloadVerified(downloadUrl: string, isAdmin: boolean): Promise<Buffer> {
    // Look up the expected checksum in the index (best-effort: if the registry is down, stays undefined)
    let expectedChecksum: string | undefined;
    try {
      const index = await this.fetchIndex();
      expectedChecksum = index.skills.find((s) => s.downloadUrl === downloadUrl)?.checksum;
    } catch {
      this.logger.warn('Registry index not available: checksum not verifiable for this download');
    }

    const buffer = await this.downloadZip(downloadUrl);

    const strict = this.config.get<string>('SKILLS_REGISTRY_STRICT_CHECKSUM', '') === 'true';
    assertSkillIntegrity(buffer, expectedChecksum, { isAdmin, strict });

    this.logger.log(
      expectedChecksum
        ? `Checksum verified for ${downloadUrl}`
        : `Skill without checksum installed by admin (no integrity verification): ${downloadUrl}`,
    );
    return buffer;
  }

  /**
   * Forces a cache refresh on the next fetchIndex().
   * Useful to force a refresh from the admin UI.
   */
  invalidateCache(): void {
    this.cache = null;
    this.logger.log('Registry cache invalidated');
  }

  /**
   * Returns metadata about the current cache (for debug/admin UI).
   */
  getCacheInfo(): { cached: boolean; ageMs?: number; skillCount?: number; registryUrl: string } {
    if (!this.cache) return { cached: false, registryUrl: this.registryUrl };
    return {
      cached:      true,
      ageMs:       Date.now() - this.cache.fetchedAt,
      skillCount:  this.cache.data.skills.length,
      registryUrl: this.registryUrl,
    };
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * Verifies that the URL domain is in the whitelist:
   *   - raw.githubusercontent.com  (GitHub raw files)
   *   - github.com                 (GitHub releases)
   *   - same domain as the configured SKILLS_REGISTRY_URL
   *
   * Add extra domains with the environment variable
   * SKILLS_REGISTRY_ALLOWED_DOMAINS (comma-separated).
   */
  private validateDownloadUrl(downloadUrl: string): void {
    let url: URL;
    try {
      url = new URL(downloadUrl);
    } catch {
      throw new ForbiddenException(
        I18nContext.current()?.t('skills.downloadUrlInvalid', { args: { url: downloadUrl } })
        ?? `Invalid download URL: ${downloadUrl}`,
      );
    }

    const allowed = this.getAllowedDomains();
    const ok = allowed.some(
      (d) => url.hostname === d || url.hostname.endsWith('.' + d),
    );

    if (!ok) {
      throw new ForbiddenException(
        I18nContext.current()?.t('skills.downloadDomainNotAllowed', { args: { hostname: url.hostname, allowed: allowed.join(', ') } })
        ?? `Download not allowed from the domain "${url.hostname}". Allowed domains: ${allowed.join(', ')}. Add more with SKILLS_REGISTRY_ALLOWED_DOMAINS.`,
      );
    }

    // HTTPS only
    if (url.protocol !== 'https:') {
      throw new ForbiddenException('skills.downloadHttpsRequired');
    }
  }

  private getAllowedDomains(): string[] {
    const base = ['raw.githubusercontent.com', 'github.com', 'objects.githubusercontent.com'];

    // Add the configured registry domain
    try {
      const registryHost = new URL(this.registryUrl).hostname;
      if (!base.includes(registryHost)) base.push(registryHost);
    } catch { /* ignore malformed URL */ }

    // Extra domains from env
    const extra = this.config.get<string>('SKILLS_REGISTRY_ALLOWED_DOMAINS', '');
    if (extra) {
      extra.split(',').map(d => d.trim()).filter(Boolean).forEach(d => {
        if (!base.includes(d)) base.push(d);
      });
    }

    return base;
  }
}
