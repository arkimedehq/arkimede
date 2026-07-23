// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

// Create/edit form for an MCP server. Conditional fields per transport:
// url for http/sse/remote, command+args for local (admin-only server-side).
// Headers, env vars and secrets are managed from the web UI.

import React from 'react';
import {resourcesApi, type McpServerSummary} from '../api/resources.js';
import type {CliConfig} from '../config.js';
import EntityForm, {type FieldDef} from './EntityForm.js';

const TRANSPORTS = ['http', 'sse', 'local', 'remote'] as const;

const FIELDS: FieldDef[] = [
    {kind: 'text', id: 'name', label: 'Name'},
    {kind: 'enum', id: 'transport', label: 'Transport', options: TRANSPORTS},
    {kind: 'text', id: 'url', label: 'URL', visibleIf: (v) => v.transport !== 'local'},
    {kind: 'text', id: 'command', label: 'Command', visibleIf: (v) => v.transport === 'local'},
    {kind: 'text', id: 'args', label: 'Args', placeholder: 'space separated', visibleIf: (v) => v.transport === 'local'},
    {kind: 'text', id: 'description', label: 'Description'},
];

export default function McpForm(props: {
    cfg: CliConfig;
    initial: McpServerSummary | null;
    onDone: (saved: boolean) => void;
}): React.JSX.Element {
    const {cfg, initial, onDone} = props;
    return (
        <EntityForm
            title={initial ? `Edit MCP server: ${initial.name}` : 'New MCP server'}
            fields={FIELDS}
            initial={{
                name: initial?.name ?? '',
                transport: initial?.transport ?? TRANSPORTS[0],
                url: initial?.url ?? '',
                command: initial?.command ?? '',
                args: ((initial as {args?: string[] | null} | null)?.args ?? []).join(' '),
                description: initial?.description ?? '',
            }}
            onSubmit={async (values) => {
                const name = values.name.trim();
                if (!name) throw new Error('Name is required.');
                const local = values.transport === 'local';
                if (local && !values.command.trim()) throw new Error('Command is required for local transport.');
                if (!local && !values.url.trim()) throw new Error('URL is required for this transport.');
                const body: Record<string, unknown> = {
                    name,
                    transport: values.transport,
                    description: values.description.trim() || undefined,
                    url: local ? undefined : values.url.trim(),
                    command: local ? values.command.trim() : undefined,
                    args: local ? values.args.trim().split(/\s+/).filter(Boolean) : undefined,
                };
                await (initial ? resourcesApi.updateMcp(cfg, initial.id, body) : resourcesApi.createMcp(cfg, body));
                onDone(true);
            }}
            onCancel={() => onDone(false)}
        />
    );
}
