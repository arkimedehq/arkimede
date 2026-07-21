import * as path from 'path';
import * as fs   from 'fs';

/**
 * Builds the PATH to inject into the skill's subprocess.
 *
 * If the skill has Nix dependencies installed (`.nix/bin/` exists in the
 * skill's directory), that directory is prepended to the PATH so that
 * `subprocess.run(['cowsay', ...])` or `require('child_process').execFile`
 * find the Nix binaries before the system ones.
 *
 * Expected structure:
 *   /app/skills/{skill_id}/.nix/      ← the skill's Nix profile
 *   /app/skills/{skill_id}/.nix/bin/  ← symlink to /nix/store/hash.../bin/*
 *
 * @param skillDir - Absolute path of the skill's directory
 * @returns PATH string ready for process.env
 */
export function buildSkillPath(skillDir: string): string {
  const nixBin  = path.join(skillDir, '.nix', 'bin');
  const basePath = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
  return fs.existsSync(nixBin) ? `${nixBin}:${basePath}` : basePath;
}
