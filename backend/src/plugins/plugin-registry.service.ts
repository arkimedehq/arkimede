// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file plugin-registry.service.ts
 *
 * The public plugin registry (specs/PLUGINS.md §12): `registry.json` at PLUGIN_REGISTRY_URL (default: the
 * arkimedehq/arkimede-plugins repository), cached for five minutes. Installing from it downloads the package over
 * HTTPS, checks its SHA-256 (mandatory) and hands it to PluginsService.install with the registry's signature.
 */
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sha256Hex } from './plugin-trust';

const OFFICIAL_REGISTRY_URL = 'https://raw.githubusercontent.com/arkimedehq/arkimede-plugins/main/registry.json';
const CACHE_MS = 5 * 60_000;
const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;

export interface RegistryPlugin {
  name: string;
  version: string;
  label?: string;
  description?: string;
  author?: string;
  homepage?: string;
  /** `personal` or `shared` (specs/EXTENSION_AUDIENCE.md), as the package declares it. */
  audience?: 'personal' | 'shared';
  url: string;
  sha256: string;
  signature?: string;
  keyId?: string;
}

/** The entries of a registry.json that can be installed (name, version, https URL, SHA-256). */
export function registryEntries(json: any): RegistryPlugin[] {
  const list = Array.isArray(json?.plugins) ? json.plugins : [];
  return list.filter((p: any) =>
    p && typeof p.name === 'string' && typeof p.version === 'string' && typeof p.url === 'string' && p.url.startsWith('https://')
    && typeof p.sha256 === 'string' && /^(sha256:)?[0-9a-f]{64}$/i.test(p.sha256.trim()));
}

@Injectable()
export class PluginRegistryService {
  private cache: { at: number; entries: RegistryPlugin[] } | null = null;

  constructor(private readonly cfg: ConfigService) {}

  private url(): string {
    return this.cfg.get<string>('PLUGIN_REGISTRY_URL') || OFFICIAL_REGISTRY_URL;
  }

  async list(refresh = false): Promise<RegistryPlugin[]> {
    if (!refresh && this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.entries;
    let res: Response;
    try {
      res = await fetch(this.url(), { signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      throw new BadRequestException(`Plugin registry not reachable: ${(err as Error).message}`);
    }
    if (!res.ok) throw new BadRequestException(`Plugin registry answered ${res.status}`);
    const entries = registryEntries(await res.json().catch(() => null));
    this.cache = { at: Date.now(), entries };
    return entries;
  }

  /** Downloads a registry plugin, checked against the registry's SHA-256. */
  async download(name: string): Promise<{ buffer: Buffer; entry: RegistryPlugin }> {
    const entry = (await this.list()).find((p) => p.name === name);
    if (!entry) throw new NotFoundException(`No plugin "${name}" in the registry`);
    const res = await fetch(entry.url, { signal: AbortSignal.timeout(60_000), redirect: 'follow' });
    if (!res.ok) throw new BadRequestException(`Package download failed (${res.status})`);
    if (!res.url.startsWith('https://')) throw new ForbiddenException('The package was not served over HTTPS');
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_PACKAGE_BYTES) throw new BadRequestException('Package too large');
    const expected = entry.sha256.replace(/^sha256:/i, '').trim().toLowerCase();
    if (sha256Hex(buffer) !== expected) throw new ForbiddenException('The package does not match the SHA-256 published in the registry');
    return { buffer, entry };
  }
}
