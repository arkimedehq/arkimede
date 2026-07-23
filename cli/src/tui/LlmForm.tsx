// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

// Create/edit form for an LLM configuration, built on EntityForm. The API
// key is write-only: masked while typing, left empty on edit to keep the
// stored key.

import React from 'react';
import {LLM_PROVIDERS, llmConfigsApi, type LlmConfigDto, type LlmConfigPayload} from '../api/llmConfigs.js';
import type {CliConfig} from '../config.js';
import EntityForm, {type FieldDef} from './EntityForm.js';

const FIELDS: FieldDef[] = [
    {kind: 'text', id: 'name', label: 'Name'},
    {kind: 'enum', id: 'provider', label: 'Provider', options: LLM_PROVIDERS},
    {kind: 'text', id: 'model', label: 'Model'},
    {kind: 'text', id: 'apiKey', label: 'API key', mask: '*'},
    {kind: 'text', id: 'baseUrl', label: 'Base URL'},
    {kind: 'text', id: 'maxTokens', label: 'Max tokens'},
];

export default function LlmForm(props: {
    cfg: CliConfig;
    initial: LlmConfigDto | null;
    onDone: (saved: boolean) => void;
}): React.JSX.Element {
    const {cfg, initial, onDone} = props;
    const fields = FIELDS.map((field) =>
        field.id === 'apiKey' && initial ? {...field, placeholder: '(unchanged)'} : field,
    );

    return (
        <EntityForm
            title={initial ? `Edit LLM configuration: ${initial.name}` : 'New LLM configuration'}
            fields={fields}
            initial={{
                name: initial?.name ?? '',
                provider: initial?.provider ?? LLM_PROVIDERS[0],
                model: initial?.model ?? '',
                baseUrl: initial?.baseUrl ?? '',
                maxTokens: initial?.maxTokens ? String(initial.maxTokens) : '',
            }}
            onSubmit={async (values) => {
                const name = values.name.trim();
                if (!name) throw new Error('Name is required.');
                let maxTokens: number | null = null;
                if (values.maxTokens.trim()) {
                    maxTokens = Number.parseInt(values.maxTokens.trim(), 10);
                    if (Number.isNaN(maxTokens)) throw new Error('Max tokens must be a number.');
                }
                const payload: LlmConfigPayload = {
                    name,
                    provider: values.provider,
                    model: values.model.trim() || null,
                    baseUrl: values.baseUrl.trim() || null,
                    maxTokens,
                };
                // Empty key on edit means "keep the stored one" — omit the field.
                if (values.apiKey.trim()) payload.apiKey = values.apiKey.trim();
                await (initial ? llmConfigsApi.update(cfg, initial.id, payload) : llmConfigsApi.create(cfg, payload));
                onDone(true);
            }}
            onCancel={() => onDone(false)}
        />
    );
}
