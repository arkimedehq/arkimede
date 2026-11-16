// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * The plugin package (specs/PLUGINS.md §4): plugin.yaml validated against contract v1, every path and script it names
 * checked against the package, the permissions worked out from the content, what an update asks beyond what was
 * approved, the events' data checked against their schema, and the routes matched and answered.
 */
import { describe, it, expect } from 'vitest';
import AdmZip from 'adm-zip';
import * as path from 'path';
import { newPermissions, readPluginPackage, validateEventData } from '../../src/plugins/plugin-manifest';
import { matchRoute, routeAnswer } from '../../src/plugins/plugin-routes';

const SKILL_MD = `---
name: records
description: Records of the test plugin.
runtime:
  network: [api.example.org]
  scripts:
    - { filename: scripts/list.py, language: python, description: Lists records }
    - { filename: scripts/sync.py, language: python, description: Syncs, mode: daemon }
    - { filename: scripts/on_event.py, language: python, description: Receives events }
---
# Records
`;

const YAML = `
contract: 1
name: test-plugin
version: 1.0.0
label: Test
description: A neutral plugin for the tests.
settings:
  - { key: API_URL, required: true }
  - { key: API_TOKEN, secret: true }
contributes:
  skills: [skills/records]
  mcp:
    - { name: records, transport: http, url: "\${API_URL}/mcp", headers: { Authorization: "Bearer \${API_TOKEN}" } }
  daemons:
    - { skill: records, script: scripts/sync.py }
  flows: [flows/new-record.json]
  routes:
    - { method: GET, path: records, skill: records, script: scripts/list.py }
    - { method: GET, path: "records/:id", skill: records, script: scripts/list.py }
  ui:
    pages:
      - { id: main, title: Records, entry: ui/index.html }
events:
  - name: record.created
    schema: { type: object, required: [id], properties: { id: { type: string } } }
subscribes: [other-plugin/thing.done]
handlers:
  events: { skill: records, script: scripts/on_event.py }
services: [notify, storage]
storage: { quotaKb: 64 }
`;

function pkg(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content));
  return zip.toBuffer();
}

const BASE: Record<string, string> = {
  'plugin.yaml': YAML,
  'skills/records/SKILL.md': SKILL_MD,
  'skills/records/scripts/list.py': 'print("{}")',
  'skills/records/scripts/sync.py': 'pass',
  'skills/records/scripts/on_event.py': 'pass',
  'flows/new-record.json': JSON.stringify({ name: 'New record', trigger: { type: 'plugin-event', plugin: { event: 'test-plugin/record.created' } } }),
  'ui/index.html': '<html></html>',
};

const withYaml = (edit: (y: string) => string, extra: Record<string, string> = {}) => pkg({ ...BASE, 'plugin.yaml': edit(YAML), ...extra });
const fails = (buf: Buffer, message: RegExp) => expect(() => readPluginPackage(buf)).toThrow(message);

describe('readPluginPackage', () => {
  it('reads a valid package: skills by their SKILL.md name, flows, and the permissions from the content', () => {
    const p = readPluginPackage(pkg(BASE));
    expect(p.manifest.name).toBe('test-plugin');
    expect(p.skills).toEqual([{ dir: 'skills/records', name: 'records', network: ['api.example.org'], scripts: [
      { filename: 'scripts/list.py', mode: 'task' }, { filename: 'scripts/sync.py', mode: 'daemon' }, { filename: 'scripts/on_event.py', mode: 'task' },
    ] }]);
    expect(p.flows[0].definition.name).toBe('New record');
    expect(p.permissions).toEqual({
      services: ['notify', 'storage'],
      subscribes: ['other-plugin/thing.done'],
      network: ['api.example.org', 'records (URL from a setting)'],
      daemons: ['records/sync.py'],
      routes: ['GET records', 'GET records/:id'],
      pages: ['main'],
      storageKb: 64,
    });
  });

  it('refuses what is not a valid package', () => {
    fails(Buffer.from('not a zip'), /not a ZIP/);
    fails(pkg({ 'README.md': 'x' }), /plugin.yaml missing/);
    fails(withYaml((y) => y.replace('contract: 1', 'contract: 2')), /contract 2 not supported/);
    fails(withYaml((y) => y.replace('name: test-plugin', 'name: Test_Plugin')), /name/);
    fails(withYaml((y) => `${y}\nunknown_field: 1\n`), /unknown_field|Unrecognized/);
  });

  it('refuses paths that leave the package', () => {
    const zip = new AdmZip(pkg(BASE));
    zip.getEntries()[0].entryName = '../evil.txt';
    fails(zip.toBuffer(), /unsafe path/);
    fails(withYaml((y) => y.replace('flows: [flows/new-record.json]', 'flows: [../x.json]')), /unsafe path/);
  });

  it('checks every script, page, flow and setting the manifest names', () => {
    fails(withYaml((y) => y.replace('skills: [skills/records]', 'skills: [skills/missing]')), /SKILL.md not found/);
    fails(withYaml((y) => y.replace('script: scripts/sync.py }', 'script: scripts/list.py }')), /must be a daemon script/);
    fails(withYaml((y) => y.replace('path: records, skill: records, script: scripts/list.py', 'path: records, skill: records, script: scripts/sync.py')), /must be a task script/);
    fails(withYaml((y) => y.replace('{ method: GET, path: records, skill: records', '{ method: GET, path: records, skill: other')), /not one of contributes.skills/);
    fails(withYaml((y) => y.replace('entry: ui/index.html', 'entry: ui/missing.html')), /ui\/missing.html not in the package/);
    fails(withYaml((y) => y.replace('${API_TOKEN}', '${OTHER}')), /\$\{OTHER\} is not a setting/);
    fails(withYaml((y) => y.replace(/handlers:\n {2}events: \{[^}]+\}\n/, '')), /subscribes needs handlers.events/);
    fails(withYaml((y) => `${y}people: { skill: records, script: scripts/sync.py }\n`), /people: scripts\/sync.py must be a task script/);
    fails(withYaml((y) => `${y}people: { skill: other, script: scripts/list.py }\n`), /people: skill "other" is not one of contributes.skills/);
    expect(readPluginPackage(withYaml((y) => `${y}people: { skill: records, script: scripts/list.py }\n`)).manifest.people)
      .toEqual({ skill: 'records', script: 'scripts/list.py' });
  });

  it('refuses a flow that is not JSON or has no name, and an invalid event schema', () => {
    fails(pkg({ ...BASE, 'flows/new-record.json': '{' }), /not valid JSON/);
    fails(pkg({ ...BASE, 'flows/new-record.json': '{"trigger":{}}' }), /needs a "name"/);
    fails(withYaml((y) => y.replace('schema: { type: object', 'schema: { type: 42')), /invalid schema/);
  });
});

describe('newPermissions', () => {
  const granted = readPluginPackage(pkg(BASE)).permissions;

  it('a first install asks everything; the same permissions ask nothing', () => {
    expect(newPermissions(null, granted)).toEqual(['(first approval)']);
    expect(newPermissions(granted, granted)).toEqual([]);
  });

  it('a new service, subscription, network, daemon or a larger quota is asked; new routes and pages are not', () => {
    const next = { ...granted, services: [...granted.services, 'agent.ask'], network: [...granted.network, 'evil.example'], storageKb: 128, routes: [...granted.routes, 'POST x'], pages: ['main', 'other'] };
    expect(newPermissions(granted, next)).toEqual(['service: agent.ask', 'network: evil.example', 'storage: 128 KB']);
  });
});

describe('validateEventData', () => {
  const { manifest } = readPluginPackage(pkg(BASE));
  it('accepts data matching the declared schema, refuses undeclared types and bad data', () => {
    expect(validateEventData(manifest, 'record.created', { id: 'r-1' })).toBeNull();
    expect(validateEventData(manifest, 'record.deleted', { id: 'r-1' })).toMatch(/not declared/);
    expect(validateEventData(manifest, 'record.created', { id: 5 })).toMatch(/data/);
    expect(validateEventData(manifest, 'record.created', [1])).toMatch(/must be an object/);
  });
});

describe('plugin routes', () => {
  const routes: any[] = [
    { method: 'GET', path: 'records/:id', skill: 's', script: 'a.py' },
    { method: 'GET', path: 'records/latest', skill: 's', script: 'b.py' },
    { method: 'POST', path: 'records', skill: 's', script: 'c.py' },
  ];

  it('matches method and path, a literal segment beating a parameter', () => {
    expect(matchRoute(routes, 'get', 'records/latest')!.route.script).toBe('b.py');
    expect(matchRoute(routes, 'GET', '/records/r%201/')).toEqual({ route: routes[0], params: { id: 'r 1' } });
    expect(matchRoute(routes, 'POST', 'records')!.route.script).toBe('c.py');
    expect(matchRoute(routes, 'DELETE', 'records')).toBeNull();
    expect(matchRoute(routes, 'GET', 'records/a/b')).toBeNull();
  });

  it('answers with the status the script gives, else its output; a failure never shows the container', () => {
    expect(routeAnswer({ success: true, output: { status: 201, body: { id: 1 } }, raw: '' })).toEqual({ status: 201, body: { id: 1 } });
    expect(routeAnswer({ success: true, output: [1, 2], raw: '' })).toEqual({ status: 200, body: [1, 2] });
    expect(routeAnswer({ success: true, output: null, raw: 'plain' })).toEqual({ status: 200, body: { text: 'plain' } });
    expect(routeAnswer({ success: true, output: { status: 99 }, raw: '' })).toEqual({ status: 200, body: { status: 99 } });
    expect(routeAnswer({ success: false, output: null, raw: 'Traceback…' })).toEqual({ status: 502, body: { error: 'The plugin could not answer this request.' } });
  });
});


describe('the example plugin (examples/plugins/notes-demo)', () => {
  it('is a valid package', () => {
    const zip = new AdmZip();
    zip.addLocalFolder(path.join(__dirname, '../../../examples/plugins/notes-demo'));
    const p = readPluginPackage(zip.toBuffer());
    expect(p.manifest.name).toBe('notes-demo');
    expect(p.permissions).toMatchObject({ services: ['notify', 'storage'], routes: ['GET notes', 'POST notes'], pages: ['notes'], storageKb: 256 });
    expect(p.flows[0].definition.trigger).toEqual({ type: 'plugin-event', plugin: { event: 'notes-demo/note.added' } });
  });
});
