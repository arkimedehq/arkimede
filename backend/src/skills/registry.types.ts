/**
 * @file registry.types.ts
 *
 * Types for the public skill registry (GitHub-based).
 *
 * The registry is a GitHub repository with:
 *   - registry.json  → index of all published skills
 *   - skills/{name}/{name}-{version}.zip  → downloadable packages
 *
 * registry.json format:
 * {
 *   "version": "1",
 *   "updatedAt": "2026-05-23T...",
 *   "skills": [ { ...RegistrySkill } ]
 * }
 */

export interface RegistrySkill {
  /** Unique skill name (kebab-case) */
  name:        string;

  /** Published version */
  version:     string;

  /** Description for the marketplace */
  description: string;

  /** Author (name or email) */
  author:      string;

  /** License (e.g. MIT, Apache-2.0) */
  license:     string;

  /** Languages of the included scripts */
  languages:   ('python' | 'node' | 'javascript')[];

  /** Tags for search/categorization */
  tags:        string[];

  /** Number of scripts in the skill */
  scriptCount: number;

  /** Dependencies declared in SKILL.md */
  dependencies: {
    python:     string[];
    javascript: string[];
  };

  /** Direct URL to the ZIP file (raw.githubusercontent.com or CDN) */
  downloadUrl: string;

  /** GitHub page of the skill (README, issues) */
  homepage?:   string;

  /** Publication/update date */
  publishedAt: string;

  /** SHA-256 of the ZIP for integrity verification (optional) */
  checksum?:   string;
}

export interface RegistryIndex {
  /** Version of the registry format (currently "1") */
  version:   string;

  /** Last update of the registry */
  updatedAt: string;

  /** List of all published skills */
  skills:    RegistrySkill[];
}
