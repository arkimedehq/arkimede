#!/usr/bin/env node
'use strict';
/**
 * One-off migration: moves the skills from the old format (skill.yaml + SKILL.md)
 * to the agentskills.io format (single SKILL.md with YAML frontmatter).
 *
 * For each skill dir under SKILLS_BASE:
 *   - if SKILL.md already has a frontmatter (`---` on the first line) → skip (idempotent)
 *   - reads skill.yaml, builds the frontmatter:
 *       name / description / version / author / license  (standard)
 *       runtime: { dependencies, network, config, scripts }  (namespaced extension)
 *   - prepends the frontmatter to the SKILL.md body, removes skill.yaml
 *
 * Usage:  node scripts/migrate-skill-frontmatter.cjs [skillsDir]
 *         (default: ./uploads/skills)
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const base = path.resolve(process.argv[2] || './uploads/skills');
if (!fs.existsSync(base)) {
  console.error(`Directory not found: ${base}`);
  process.exit(1);
}

function hasFrontmatter(md) {
  return /^﻿?---[ \t]*\r?\n/.test(md);
}

/** Builds the frontmatter object from the skill.yaml object (controlled key order). */
function buildFrontmatter(y) {
  const fm = {};
  fm.name = y.name;
  fm.description = y.description;
  if (y.version !== undefined) fm.version = y.version;
  if (y.author !== undefined && y.author !== null) fm.author = y.author;
  if (y.license !== undefined && y.license !== null) fm.license = y.license;

  const runtime = {};
  if (y.dependencies !== undefined) runtime.dependencies = y.dependencies;
  if (y.network !== undefined) runtime.network = y.network;
  if (y.config !== undefined) runtime.config = y.config;
  if (y.scripts !== undefined) runtime.scripts = y.scripts;
  if (Object.keys(runtime).length) fm.runtime = runtime;

  return fm;
}

let migrated = 0, skipped = 0, errors = 0;

for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = path.join(base, entry.name);
  const yamlPath = path.join(dir, 'skill.yaml');
  const mdPath = path.join(dir, 'SKILL.md');

  if (!fs.existsSync(mdPath)) { console.warn(`- ${entry.name}: no SKILL.md, skip`); skipped++; continue; }

  const md = fs.readFileSync(mdPath, 'utf-8');
  if (hasFrontmatter(md)) { console.log(`= ${entry.name}: already has frontmatter, skip`); skipped++; continue; }

  if (!fs.existsSync(yamlPath)) { console.warn(`! ${entry.name}: SKILL.md without frontmatter and without skill.yaml — skip`); skipped++; continue; }

  try {
    const y = yaml.load(fs.readFileSync(yamlPath, 'utf-8')) || {};
    const fm = buildFrontmatter(y);
    const fmText = yaml.dump(fm, { lineWidth: -1, noRefs: true });
    const out = `---\n${fmText}---\n\n${md.replace(/^﻿/, '')}`;
    fs.writeFileSync(mdPath, out);
    fs.rmSync(yamlPath);
    console.log(`✓ ${entry.name}: migrated (name="${fm.name}", scripts=${fm.runtime?.scripts?.length ?? 0})`);
    migrated++;
  } catch (err) {
    console.error(`✗ ${entry.name}: error — ${err.message}`);
    errors++;
  }
}

console.log(`\nMigration completed: ${migrated} migrated, ${skipped} skipped, ${errors} errors.`);
process.exit(errors ? 1 : 0);
