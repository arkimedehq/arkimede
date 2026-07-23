// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

// Create/edit form for a custom tool. The TUI supports the self-contained
// executor types (http: URL+method, prompt: sub-agent prompts); sql/rag/
// mongo/redis tools need data-source and collection pickers and are managed
// from the web UI (their description stays editable here). On edit the
// existing executorConfig is merged, so advanced fields set on the web
// (headers, timeouts, llmConfigId…) are preserved. The tool name is
// immutable after creation (backend contract).

import React from 'react';
import {resourcesApi, type CustomToolSummary} from '../api/resources.js';
import type {CliConfig} from '../config.js';
import EntityForm, {type FieldDef} from './EntityForm.js';

const TUI_TYPES = ['http', 'prompt'] as const;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

const isHttp = (v: Record<string, string>) => v.executorType === 'http';
const isPrompt = (v: Record<string, string>) => v.executorType === 'prompt';

export default function ToolForm(props: {
    cfg: CliConfig;
    initial: CustomToolSummary | null;
    onDone: (saved: boolean) => void;
}): React.JSX.Element {
    const {cfg, initial, onDone} = props;
    const configurable = !initial || TUI_TYPES.includes(initial.executorType as (typeof TUI_TYPES)[number]);
    const config = (initial?.executorConfig ?? {}) as Record<string, unknown>;

    const fields: FieldDef[] = [
        ...(initial ? [] : [{kind: 'text', id: 'name', label: 'Name', placeholder: 'snake_case'} as FieldDef]),
        {kind: 'text', id: 'description', label: 'Description'},
        ...(initial
            ? []
            : [{kind: 'enum', id: 'executorType', label: 'Type', options: TUI_TYPES} as FieldDef]),
        ...(configurable
            ? ([
                  {kind: 'text', id: 'url', label: 'URL', visibleIf: isHttp},
                  {kind: 'enum', id: 'method', label: 'Method', options: METHODS, visibleIf: isHttp},
                  {kind: 'text', id: 'systemPrompt', label: 'System prompt', visibleIf: isPrompt},
                  {kind: 'text', id: 'userPromptTemplate', label: 'User template', visibleIf: isPrompt},
              ] as FieldDef[])
            : []),
    ];

    return (
        <EntityForm
            title={
                initial
                    ? `Edit tool: ${initial.name}${configurable ? '' : ` (${initial.executorType} config is web-only)`}`
                    : 'New custom tool'
            }
            fields={fields}
            initial={{
                description: initial?.description ?? '',
                executorType: initial?.executorType ?? TUI_TYPES[0],
                url: typeof config.url === 'string' ? config.url : '',
                method: typeof config.method === 'string' ? config.method : METHODS[0],
                systemPrompt: typeof config.systemPrompt === 'string' ? config.systemPrompt : '',
                userPromptTemplate: typeof config.userPromptTemplate === 'string' ? config.userPromptTemplate : '',
            }}
            onSubmit={async (values) => {
                const description = values.description.trim();
                if (!description) throw new Error('Description is required (the LLM uses it to pick the tool).');
                const type = initial?.executorType ?? values.executorType;
                let executorConfig: Record<string, unknown> | undefined;
                if (type === 'http') {
                    if (!values.url.trim()) throw new Error('URL is required for http tools.');
                    executorConfig = {...config, url: values.url.trim(), method: values.method};
                } else if (type === 'prompt') {
                    if (!values.systemPrompt.trim()) throw new Error('System prompt is required for prompt tools.');
                    executorConfig = {
                        ...config,
                        systemPrompt: values.systemPrompt.trim(),
                        userPromptTemplate: values.userPromptTemplate.trim() || undefined,
                    };
                }
                if (initial) {
                    const body: Record<string, unknown> = {description};
                    if (executorConfig) body.executorConfig = executorConfig;
                    await resourcesApi.updateTool(cfg, initial.id, body);
                } else {
                    const name = values.name.trim();
                    if (!name) throw new Error('Name is required.');
                    await resourcesApi.createTool(cfg, {
                        name,
                        description,
                        executorType: type,
                        executorConfig,
                        parameters: [],
                    });
                }
                onDone(true);
            }}
            onCancel={() => onDone(false)}
        />
    );
}
