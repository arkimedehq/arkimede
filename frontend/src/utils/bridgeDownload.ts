// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

// bridgeDownload.ts — resolves where the user downloads the Electron desktop
// "bridge" from. The binaries (dmg/exe/AppImage) are NOT in the repo: they are
// published as assets of a GitHub Release by the `release-bridge.yml` workflow.
// Here we detect the visitor's OS (for the label) and point at the newest `bridge-v*`
// release, whose assets are named per-OS/arch so the user picks the right installer.
// NB: GitHub's `releases/latest` is NOT usable — the repo also publishes app releases
// (`v*`) without bridge assets, and those win the "Latest" badge.
//
// The repo slug lives in ONE place — `VITE_BRIDGE_REPO` (frontend/.env). It defaults to the
// public repo, where the releases actually live: a private fallback would 404 for everyone.

export type BridgeOS = 'mac' | 'windows' | 'linux' | 'unknown';

// Public repo that hosts the bridge releases; override via VITE_BRIDGE_REPO at build time
// (e.g. a fork publishing its own binaries).
const REPO = (import.meta.env.VITE_BRIDGE_REPO as string | undefined) || 'arkimedehq/arkimede';

/** Best-effort OS detection from the browser, only used to label the button. */
export function detectBridgeOS(): BridgeOS {
  const s = `${navigator.userAgent} ${navigator.platform}`.toLowerCase();
  if (/mac|iphone|ipad|darwin/.test(s)) return 'mac';
  if (/win/.test(s)) return 'windows';
  if (/linux|android|x11/.test(s)) return 'linux';
  return 'unknown';
}

/** Human label for the detected OS (proper nouns — same in every language). */
export function bridgeOSLabel(os: BridgeOS): string | null {
  switch (os) {
    case 'mac': return 'macOS';
    case 'windows': return 'Windows';
    case 'linux': return 'Linux';
    default: return null;
  }
}

const BRIDGE_TAG_PREFIX = 'bridge-v';

/**
 * Fallback link, usable synchronously: the releases page filtered on bridge tags.
 * Used until (or if) the GitHub API lookup below fails — e.g. rate limit, offline.
 */
export function bridgeReleasesUrl(): string {
  return `https://github.com/${REPO}/releases?q=${BRIDGE_TAG_PREFIX}&expanded=true`;
}

/**
 * Resolves the page of the newest published bridge release via the public GitHub API
 * (unauthenticated, CORS-enabled). The API lists releases newest-first; drafts and
 * prereleases are skipped. Throws on network/API errors — callers fall back to
 * `bridgeReleasesUrl()`.
 */
export async function fetchLatestBridgeReleaseUrl(): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=50`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const releases = (await res.json()) as Array<{
    tag_name: string;
    html_url: string;
    draft: boolean;
    prerelease: boolean;
  }>;
  const latest = releases.find(
    (r) => !r.draft && !r.prerelease && r.tag_name.startsWith(BRIDGE_TAG_PREFIX),
  );
  if (!latest) throw new Error('No bridge release found');
  return latest.html_url;
}
