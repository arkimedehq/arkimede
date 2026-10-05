// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Plug, Sparkles, Workflow, Wrench, Bot, ChevronDown, ChevronRight } from 'lucide-react';
import { agentsApi, type ToolCatalogGroup } from '../api/agents';

const SOURCE_META: Record<ToolCatalogGroup['source'], { Icon: React.ElementType; color: string }> = {
  mcp:    { Icon: Plug,     color: 'text-blue-400' },
  skill:  { Icon: Sparkles, color: 'text-violet-400' },
  flow:   { Icon: Workflow, color: 'text-amber-400' },
  agent:  { Icon: Bot,      color: 'text-emerald-400' },
  custom: { Icon: Wrench,   color: 'text-teal-400' },
};

/**
 * Tool picker for a `names` tool filter (agents, automations). Selection is a set of tokens:
 * individual tool names and/or per-source wildcards (e.g. "mcp_home_assistant_*").
 * Selecting a group's wildcard supersedes its individual tools (which the backend
 * matches by prefix), so those checkboxes are shown as covered.
 */
export function ToolPicker({ selected, onChange }: { selected: Set<string>; onChange: (s: Set<string>) => void }) {
  const { t } = useTranslation('agents');
  const { data, isLoading, isError } = useQuery({
    queryKey: ['agent-tool-catalog'],
    queryFn: () => agentsApi.toolCatalog(),
    staleTime: 30_000,
  });
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const toggle = (token: string) => {
    const next = new Set(selected);
    next.has(token) ? next.delete(token) : next.add(token);
    onChange(next);
  };

  if (isLoading) return <p className="text-xs text-gray-500 flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> {t('modal.toolPickerLoading')}</p>;
  if (isError || !data) return <p className="text-xs text-red-400">{t('modal.toolPickerError')}</p>;
  if (data.groups.length === 0) return <p className="text-xs text-gray-500">{t('modal.toolPickerEmpty')}</p>;

  const selectedCount = selected.size;

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-gray-500">{t('modal.toolPickerHint', { count: selectedCount })}</p>
      <div className="max-h-72 overflow-y-auto space-y-2 rounded-lg border border-gray-800 p-2">
        {data.groups.map((g, gi) => {
          const key = `${g.source}:${g.wildcard ?? g.label}:${gi}`;
          const wildcardOn = g.wildcard != null && selected.has(g.wildcard);
          const isOpen = !collapsed[key];
          const { Icon, color } = SOURCE_META[g.source];
          return (
            <div key={key} className="rounded-md bg-gray-900/40">
              <div className="flex items-center gap-2 px-2 py-1.5">
                <button type="button" onClick={() => setCollapsed((c) => ({ ...c, [key]: isOpen }))}
                  className="text-gray-500 hover:text-gray-300">
                  {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </button>
                <Icon size={13} className={color} />
                <span className="text-xs font-medium text-gray-200 flex-1 truncate">{g.label}</span>
                {g.wildcard && (
                  <label className="flex items-center gap-1.5 text-[11px] text-gray-400 cursor-pointer" title={g.wildcard}>
                    <input type="checkbox" className="accent-indigo-500" checked={wildcardOn} onChange={() => toggle(g.wildcard!)} />
                    {t('modal.toolPickerWholeGroup')}
                  </label>
                )}
              </div>
              {isOpen && (
                <div className="pl-8 pr-2 pb-2 space-y-1">
                  {g.tools.map((tool) => (
                    <label key={tool.name} className={`flex items-start gap-2 text-xs cursor-pointer ${wildcardOn ? 'opacity-50' : ''}`}>
                      <input type="checkbox" className="mt-0.5 accent-indigo-500"
                        checked={wildcardOn || selected.has(tool.name)}
                        disabled={wildcardOn}
                        onChange={() => toggle(tool.name)} />
                      <span className="min-w-0">
                        <span className="font-mono text-gray-300">{tool.name}</span>
                        {tool.description && <span className="block text-[11px] text-gray-500 truncate">{tool.description}</span>}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
