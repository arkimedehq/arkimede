import { execFile } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { promisify } from 'util';
import { InstallRequest, InstallResult } from './types';

const execFileAsync   = promisify(execFile);
const SKILLS_BASE     = process.env.SKILLS_BASE_PATH ?? '/app/skills';
const INSTALL_TIMEOUT = parseInt(process.env.INSTALL_TIMEOUT_MS ?? '300000', 10); // 5 min

// ─── Nix: base env for all nix subprocesses ───────────────────────────────────
// HOME is needed because nix reads ~/.config/nix/nix.conf and ~/.nix-profile.
// NIX_SSL_CERT_FILE avoids SSL errors in Debian/Ubuntu containers.
const NIX_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  HOME:             process.env.HOME             ?? '/home/executor',
  NIX_SSL_CERT_FILE: process.env.NIX_SSL_CERT_FILE ?? '/etc/ssl/certs/ca-certificates.crt',
};

const log = {
  info:  (msg: string) => process.stderr.write(`[install] ${msg}\n`),
  warn:  (msg: string) => process.stderr.write(`[install] ⚠ ${msg}\n`),
  error: (msg: string) => process.stderr.write(`[install] ✗ ${msg}\n`),
};

/**
 * Installs a skill's Python and JavaScript dependencies in its
 * isolated directory under /app/skills/{skill_id}/.deps/
 *
 * Each skill has its own completely separate dependencies:
 *   Python → pip install --target /app/skills/{id}/.deps/python
 *   JS     → npm install --prefix /app/skills/{id}/.deps/node
 *
 * This guarantees:
 * - No version conflicts between different skills
 * - Clean removal: just delete the skill's .deps folder
 * - Independent update per skill
 */
export async function installSkillDeps(req: InstallRequest): Promise<InstallResult> {
  const start      = Date.now();
  const skillDir   = path.join(SKILLS_BASE, req.skill_id);
  let   installLog = '';

  if (!fs.existsSync(skillDir)) {
    log.error(`skill directory not found: ${skillDir}`);
    return { ok: false, log: `Skill directory not found: ${skillDir}`, duration_ms: 0 };
  }

  // ── Diagnostics: which python3/pip3/nix will be used ──────────────────────
  try {
    const { stdout } = await execFileAsync('python3', ['--version']);
    log.info(`python3: ${stdout.trim()}`);
  } catch (e: any) { log.warn(`python3 not found: ${e.message}`); }

  try {
    const { stdout } = await execFileAsync('pip3', ['--version']);
    log.info(`pip3: ${stdout.trim()}`);
  } catch (e: any) { log.warn(`pip3 not found: ${e.message}`); }

  try {
    const { stdout } = await execFileAsync('nix', ['--version'], { env: NIX_ENV });
    log.info(`nix: ${stdout.trim()}`);
  } catch { log.warn('nix not found in PATH — system.nix dependencies cannot be installed'); }

  try {
    // ─── Python deps ────────────────────────────────────────────────────────
    if (req.python_deps.length > 0) {
      const targetDir = path.join(skillDir, '.deps', 'python');
      fs.mkdirSync(targetDir, { recursive: true });

      log.info(`installing Python deps → ${targetDir}`);
      log.info(`  packages: ${req.python_deps.join(', ')}`);
      installLog += `\n=== Installing Python deps ===\n${req.python_deps.join('\n')}\n`;

      for (const dep of req.python_deps) {
        validateDependencySpec(dep, 'python');
      }

      const { stdout, stderr } = await execFileAsync(
        'pip3',
        ['install', '--target', targetDir, '--no-cache-dir', '--quiet', ...req.python_deps],
        { timeout: INSTALL_TIMEOUT },
      );

      if (stdout) installLog += stdout;
      if (stderr) {
        installLog += stderr;
        log.info(`  pip output:\n${stderr.trim().slice(0, 500)}`);
      }
      installLog += `\nPython deps installed to: ${targetDir}\n`;
      log.info(`  ✓ Python deps installed`);
    }

    // ─── JavaScript deps ─────────────────────────────────────────────────────
    if (req.js_deps.length > 0) {
      const prefixDir = path.join(skillDir, '.deps', 'node');
      fs.mkdirSync(prefixDir, { recursive: true });

      log.info(`installing JS deps → ${prefixDir}`);
      log.info(`  packages: ${req.js_deps.join(', ')}`);
      installLog += `\n=== Installing JS deps ===\n${req.js_deps.join('\n')}\n`;

      for (const dep of req.js_deps) {
        validateDependencySpec(dep, 'javascript');
      }

      const pkgJsonPath = path.join(prefixDir, 'package.json');
      if (!fs.existsSync(pkgJsonPath)) {
        fs.writeFileSync(pkgJsonPath, JSON.stringify({ name: 'skill-deps', version: '1.0.0', private: true }));
      }

      const { stdout, stderr } = await execFileAsync(
        'npm',
        ['install', '--prefix', prefixDir, '--no-audit', '--no-fund', '--loglevel', 'error', ...req.js_deps],
        { timeout: INSTALL_TIMEOUT },
      );

      if (stdout) installLog += stdout;
      if (stderr)  installLog += stderr;
      installLog += `\nJS deps installed to: ${prefixDir}/node_modules\n`;
      log.info(`  ✓ JS deps installed`);
    }

    // ─── Nix deps ─────────────────────────────────────────────────────────────
    const nix_deps = req.nix_deps ?? [];
    if (nix_deps.length > 0) {
      installLog += `\n=== Installing Nix deps ===\n${nix_deps.join('\n')}\n`;

      // Check that nix is available before attempting the installation.
      // In local dev (macOS/Linux without Nix) we skip with a warning instead
      // of failing the entire installation — the tools must be installed
      // manually (e.g. brew install cowsay boxes jp2a imagemagick).
      const nixAvailable = await execFileAsync('nix', ['--version'], { env: NIX_ENV })
        .then(() => true)
        .catch(() => false);

      if (!nixAvailable) {
        const warn = `⚠ nix not found in PATH — Nix deps skipped (${nix_deps.join(', ')}). `
          + `Install them manually or use the Docker environment.`;
        log.warn(warn);
        installLog += warn + '\n';
      } else {
        const profileDir = path.join(skillDir, '.nix');
        // nix creates the profile as a SYMLINK at profileDir. It must NOT pre-exist as a
        // directory — nix readlink()s it and fails with EINVAL ("reading symbolic link …:
        // Invalid argument") on nix 2.34+. Ensure the PARENT exists and clear any stale
        // profile path (leftover dir from this bug, or an old symlink) so nix owns it.
        fs.mkdirSync(skillDir, { recursive: true });
        fs.rmSync(profileDir, { recursive: true, force: true });

        log.info(`installing Nix deps → ${profileDir}`);
        log.info(`  packages: ${nix_deps.join(', ')}`);

        for (const dep of nix_deps) {
          validateNixPackage(dep);
        }

        // Each package becomes "nixpkgs#name" if not already qualified
        const packages = nix_deps.map(d => d.includes('#') ? d : `nixpkgs#${d}`);

        // nix profile install --profile <dir> nixpkgs#pkg1 nixpkgs#pkg2 ...
        // The profile creates symlinks in <dir>/bin/ → /nix/store/hash.../bin/
        const { stdout, stderr } = await execFileAsync(
          'nix',
          [
            'profile', 'install',
            '--profile', profileDir,
            '--no-write-lock-file',
            ...packages,
          ],
          { timeout: INSTALL_TIMEOUT, env: NIX_ENV },
        );

        if (stdout) installLog += stdout;
        if (stderr) {
          installLog += stderr;
          // nix writes info/warnings to stderr even on success
          log.info(`  nix output:\n${stderr.trim().slice(0, 500)}`);
        }
        installLog += `\nNix deps installed to: ${profileDir}\n`;
        log.info(`  ✓ Nix deps installed`);
      }
    }

    installLog += `\n✓ Installation complete in ${Date.now() - start}ms`;
    return { ok: true, log: installLog, duration_ms: Date.now() - start };

  } catch (err: any) {
    log.error(`installation failed: ${err.message}`);
    installLog += `\n✗ Installation failed: ${err.message}`;
    return { ok: false, log: installLog, duration_ms: Date.now() - start };
  }
}

/**
 * Validates that a package specifier is safe to install.
 * Blocks local paths, git URLs, http, file: etc.
 * Allows only standard PyPI/npm specifiers.
 */
function validateDependencySpec(spec: string, type: 'python' | 'javascript'): void {
  const blocked = [
    /^\.{1,2}[\\/]/,
    /^\/[^/]/,
    /^git\+/i,
    /^github:/i,
    /^https?:\/\//i,
    /^file:/i,
    /^ssh:/i,
  ];

  for (const pattern of blocked) {
    if (pattern.test(spec.trim())) {
      throw new Error(`Blocked dependency specifier [${type}]: "${spec}" — only PyPI/npm packages allowed`);
    }
  }
}

/**
 * Validates that a Nix package name is safe to install.
 *
 * Allows:
 *   - Simple names:         "cowsay", "ffmpeg", "imagemagick"
 *   - Nested attributes:    "python3Packages.requests", "nodePackages.pm2"
 *   - Already qualified:    "nixpkgs#cowsay" (the # is handled separately)
 *
 * Blocks anything containing shell metacharacters, path traversal,
 * URLs or references to arbitrary flakes (e.g. "github:user/repo#pkg").
 */
function validateNixPackage(pkg: string): void {
  const blocked = [
    /\.\./,           // path traversal
    /[;&|`$<>]/,      // shell metacharacters
    /\s/,             // whitespace
    /^github:/i,      // arbitrary github: flakes
    /^git\+/i,        // arbitrary git+ flakes
    /^https?:\/\//i,  // direct URLs
    /^file:/i,        // local paths
    /^path:/i,        // local Nix paths
  ];

  for (const pattern of blocked) {
    if (pattern.test(pkg)) {
      throw new Error(`Invalid Nix package name: "${pkg}" — only nixpkgs names allowed (e.g. "cowsay", "python3Packages.requests")`);
    }
  }

  // Allows: letters, digits, hyphen, underscore, dot, # (for nixpkgs#name)
  if (!/^[a-zA-Z0-9_\-\.#]+$/.test(pkg)) {
    throw new Error(`Invalid Nix package name: "${pkg}" — allowed characters: a-z A-Z 0-9 - _ . #`);
  }
}