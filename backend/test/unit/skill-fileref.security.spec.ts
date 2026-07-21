/**
 * C2 copy-in — `buildSkillTool` recognizes `format: file-ref` params, resolves them
 * via resolver (access-aware) and populates `ExecuteRequest.files`; if the resolver
 * DENIES access the file is not staged. Migrated from scripts/smoke-fileref-copyin.ts.
 *
 * Pure logic: client and resolver are mocks, no DB.
 */
import { describe, it, expect } from 'vitest';
import { buildSkillTool } from '../../src/skills/skill-tool.factory';

function makeTool(resolver: any, schemaProps: any) {
  let captured: any = null;
  const client: any = {
    execute: async (req: any) => { captured = req; return { stdout: '{}', stderr: '', exit_code: 0, duration_ms: 1 }; },
  };
  const skill: any = { id: 'skill-1', name: 'test' };
  const script: any = { filename: 'scripts/x.py', language: 'python', inputSchema: { type: 'object', properties: schemaProps } };
  const tool = buildSkillTool(skill, script, client, {}, null, 'user-1', resolver);
  return { tool, get: () => captured };
}

// The resolver denies access for the value 'denied' (→ null), otherwise it stages.
const resolver = async (v: string) => (v === 'denied' ? null : { hostPath: `/abs/${v}.pdf`, name: `${v}.pdf` });

describe('skill copy-in (file-ref)', () => {
  it('param file-ref risolto → files[] popolato con param e hostPath', async () => {
    const { tool, get } = makeTool(resolver, { file_path: { type: 'string', format: 'file-ref' } });
    await tool.invoke({ file_path: 'doc123' });
    const req = get();
    expect(req?.files).toHaveLength(1);
    expect(req.files[0]).toMatchObject({ param: 'file_path', hostPath: '/abs/doc123.pdf' });
  });

  it('param normale (senza format:file-ref) → nessuno staging', async () => {
    const { tool, get } = makeTool(resolver, { note: { type: 'string' } });
    await tool.invoke({ note: 'ciao' });
    expect(get()?.files).toBeFalsy();
  });

  it('resolver nega l\'accesso (null) → file NON stagiato', async () => {
    const { tool, get } = makeTool(resolver, { file_path: { type: 'string', format: 'file-ref' } });
    await tool.invoke({ file_path: 'denied' });
    expect(get()?.files).toBeFalsy();
  });

  it('arg file-ref assente → nessun files[]', async () => {
    const { tool, get } = makeTool(resolver, { file_path: { type: 'string', format: 'file-ref' } });
    await tool.invoke({});
    expect(get()?.files).toBeFalsy();
  });
});
