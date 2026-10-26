// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Does an LLM provider accept the Recordare tools as the agent binds them? One live call with the tools bound exactly
 * as RecordareMcpService.buildTools does (name `recordare_<tool>`, MCP JSON Schema as the input schema, log_episode not
 * offered). The provider validates every tool declaration on the request, so one call checks them all.
 *   cd ~/Development/recordare/service && node -r @swc-node/register scripts/dump-mcp-tools.ts > /tmp/tools.json
 *   GEMINI_API_KEY=… npx ts-node --transpile-only scripts/check-llm-tools.ts /tmp/tools.json gemini gemini-3.1-flash-lite
 *   OPENAI_API_KEY=… npx ts-node --transpile-only scripts/check-llm-tools.ts /tmp/tools.json openai gpt-5.4-nano
 */
import { readFileSync } from 'fs';
import { DynamicStructuredTool } from '@langchain/core/tools';

/** As RecordareMcpService's NOT_OFFERED (its module pulls the client, which plain ts-node cannot load). */
const NOT_OFFERED = new Set(['log_episode']);

type McpTool = { name: string; description?: string; inputSchema: Record<string, unknown> };

async function main(): Promise<void> {
  const [file, provider, model] = process.argv.slice(2);
  if (!file || !provider || !model) throw new Error('usage: check-llm-tools.ts <tools.json> <gemini|openai> <model>');
  const listed = (JSON.parse(readFileSync(file, 'utf8')) as McpTool[]).filter((t) => !NOT_OFFERED.has(t.name));
  const tools = listed.map((t) => new DynamicStructuredTool({
    name: `recordare_${t.name}`, description: t.description ?? t.name, schema: t.inputSchema as any, func: async () => 'ok',
  }));
  let llm: any;
  if (provider === 'gemini') {
    const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
    llm = new ChatGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY ?? '', model, maxOutputTokens: 300 });
  } else if (provider === 'openai') {
    const { ChatOpenAI } = require('@langchain/openai');
    llm = new ChatOpenAI({ apiKey: process.env.OPENAI_API_KEY ?? '', model, maxTokens: 300 });
  } else {
    throw new Error(`unknown provider ${provider}`);
  }
  const started = Date.now();
  const res = await llm.bindTools(tools).invoke(
    'Search your episodic memory: what did I do last weekend? Then correct episode 6f1c2b8e-1d2a-4c3b-9e8f-0a1b2c3d4e5f: the date was Sunday, not Saturday.');
  console.log(JSON.stringify({
    provider, model, ms: Date.now() - started, tools: tools.map((t) => t.name),
    toolCalls: (res.tool_calls ?? []).map((c: any) => ({ name: c.name, args: c.args })),
    usage: res.usage_metadata,
  }, null, 1));
}

main().catch((e: unknown) => { console.error('REJECTED:', (e as Error).message); process.exit(1); });
