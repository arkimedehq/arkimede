// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

// Individual tabs of the settings panel. Each tab fetches its own data on
// mount (i.e. every time it becomes active). List tabs support row selection
// (↑/↓) and an action on the selected row (Space/Enter): toggle enabled for
// tools/skills/MCP servers, set-default for LLM configs.

import {Box, Text, useInput} from 'ink';
import Spinner from 'ink-spinner';
import React, {useEffect, useState} from 'react';
import {authApi} from '../api/auth.js';
import {ApiError} from '../api/http.js';
import {llmConfigsApi, type LlmConfigDto} from '../api/llmConfigs.js';
import {
    resourcesApi,
    type TokenGroup,
    type UsageSummary,
} from '../api/resources.js';
import type {CliConfig} from '../config.js';
import LlmForm from './LlmForm.js';
import McpForm from './McpForm.js';
import ToolForm from './ToolForm.js';

export interface TabProps {
    cfg: CliConfig;
    /**
     * Tabs call this when they enter/leave a modal state (form, confirm):
     * while locked the panel stops handling tab-switch/close keys so that
     * typed digits and Tab/Esc reach the tab's own inputs.
     */
    onLockChange?: (locked: boolean) => void;
}

const MAX_LIST_ROWS = 25;

// ── Data loading ────────────────────────────────────────────────────────────

interface LoadState<T> {
    data: T | null;
    loading: boolean;
    error: string | null;
    denied: boolean;
}

function useLoad<T>(
    fetcher: () => Promise<T>,
): LoadState<T> & {setData: (updater: (prev: T) => T) => void; reload: () => void} {
    const [state, setState] = useState<LoadState<T>>({data: null, loading: true, error: null, denied: false});
    const [version, setVersion] = useState(0);
    useEffect(() => {
        let cancelled = false;
        setState((prev) => ({...prev, loading: true}));
        void fetcher()
            .then((data) => {
                if (!cancelled) setState({data, loading: false, error: null, denied: false});
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                const denied = err instanceof ApiError && err.status === 403;
                setState({
                    data: null,
                    loading: false,
                    denied,
                    error: denied ? null : err instanceof Error ? err.message : String(err),
                });
            });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [version]);
    const setData = (updater: (prev: T) => T) =>
        setState((prev) => (prev.data === null ? prev : {...prev, data: updater(prev.data)}));
    return {...state, setData, reload: () => setVersion((v) => v + 1)};
}

function Status({state, children}: {state: LoadState<unknown>; children?: React.ReactNode}): React.JSX.Element | null {
    if (state.loading) {
        return (
            <Text color="yellow">
                <Spinner type="dots" /> loading…
            </Text>
        );
    }
    if (state.denied) return <Text dimColor>Visible to admins only.</Text>;
    if (state.error) return <Text color="red">⚠ {state.error}</Text>;
    return <>{children}</>;
}

// ── Row selection + action on interactive lists ─────────────────────────────

interface ListNav {
    selected: number;
    busy: boolean;
    actionError: string | null;
}

function useListNav<T>(items: T[], action: (item: T) => Promise<void>): ListNav {
    const [selected, setSelected] = useState(0);
    const [busy, setBusy] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);
    const clamped = items.length === 0 ? 0 : Math.min(selected, items.length - 1);

    useInput((char, key) => {
        if (items.length === 0 || busy) return;
        if (key.upArrow) {
            setSelected(Math.max(0, clamped - 1));
            setActionError(null);
        } else if (key.downArrow) {
            setSelected(Math.min(items.length - 1, clamped + 1));
            setActionError(null);
        } else if (char === ' ' || key.return) {
            setBusy(true);
            setActionError(null);
            void action(items[clamped])
                .catch((err: unknown) => {
                    setActionError(
                        err instanceof ApiError && err.status === 403
                            ? 'Not allowed (admin or owner only).'
                            : err instanceof Error
                              ? err.message
                              : String(err),
                    );
                })
                .finally(() => setBusy(false));
        }
    });

    return {selected: clamped, busy, actionError};
}

// ── Full CRUD lists (add/edit/delete + primary action) ──────────────────────

interface CrudState<T> {
    mode: 'list' | 'form' | 'delete';
    editing: T | null;
    selected: number;
    busy: boolean;
    actionError: string | null;
    closeForm: (saved: boolean) => void;
}

function useCrudList<T>(opts: {
    rows: T[];
    isActive: boolean;
    onLockChange?: (locked: boolean) => void;
    /** Enter/Space on the selected row (e.g. toggle, set default). */
    primary: (item: T) => Promise<void>;
    remove: (item: T) => Promise<void>;
    /** Return an error message to refuse deletion (e.g. last item). */
    deleteGuard?: (rows: T[]) => string | null;
    reload: () => void;
}): CrudState<T> {
    const {rows, isActive, onLockChange, primary, remove, deleteGuard, reload} = opts;
    const [mode, setMode] = useState<'list' | 'form' | 'delete'>('list');
    const [editing, setEditing] = useState<T | null>(null);
    const [selected, setSelected] = useState(0);
    const [busy, setBusy] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);
    const clamped = rows.length === 0 ? 0 : Math.min(selected, rows.length - 1);

    // Lock the panel's tab-switch keys while a modal (form/confirm) is open.
    useEffect(() => {
        onLockChange?.(mode !== 'list');
        return () => onLockChange?.(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode]);

    const fail = (err: unknown) =>
        setActionError(
            err instanceof ApiError && err.status === 403
                ? 'Not allowed (admin or owner only).'
                : err instanceof Error
                  ? err.message
                  : String(err),
        );

    useInput(
        (char, key) => {
            if (busy) return;
            if (char === 'a') {
                setEditing(null);
                setMode('form');
                setActionError(null);
                return;
            }
            if (rows.length === 0) return;
            if (key.upArrow) {
                setSelected(Math.max(0, clamped - 1));
                setActionError(null);
            } else if (key.downArrow) {
                setSelected(Math.min(rows.length - 1, clamped + 1));
                setActionError(null);
            } else if (char === 'e') {
                setEditing(rows[clamped]);
                setMode('form');
                setActionError(null);
            } else if (char === 'd') {
                const guard = deleteGuard?.(rows) ?? null;
                if (guard) setActionError(guard);
                else {
                    setMode('delete');
                    setActionError(null);
                }
            } else if (key.return || char === ' ') {
                setBusy(true);
                setActionError(null);
                void primary(rows[clamped]).catch(fail).finally(() => setBusy(false));
            }
        },
        {isActive: isActive && mode === 'list'},
    );

    useInput(
        (char, key) => {
            if (busy) return;
            if (char === 'y') {
                setBusy(true);
                void remove(rows[clamped])
                    .then(() => {
                        setMode('list');
                        reload();
                    })
                    .catch((err: unknown) => {
                        setMode('list');
                        fail(err);
                    })
                    .finally(() => setBusy(false));
            } else if (char || key.escape || key.return) {
                setMode('list');
            }
        },
        {isActive: mode === 'delete'},
    );

    return {
        mode,
        editing,
        selected: clamped,
        busy,
        actionError,
        closeForm: (saved: boolean) => {
            setMode('list');
            if (saved) reload();
        },
    };
}

function CrudFooter<T>(props: {
    crud: CrudState<T>;
    rows: T[];
    nameOf: (item: T) => string;
    primaryHint: string;
}): React.JSX.Element {
    const {crud, rows, nameOf, primaryHint} = props;
    const target = rows[crud.selected];
    return (
        <Box marginTop={1} flexDirection="column">
            {crud.mode === 'delete' && target ? (
                <Text color="red">Delete "{nameOf(target)}"? y = yes, any other key = no</Text>
            ) : null}
            {crud.actionError ? <Text color="red">⚠ {crud.actionError}</Text> : null}
            <Text dimColor>
                {crud.busy ? (
                    <>
                        <Spinner type="dots" /> applying…
                    </>
                ) : (
                    `↑/↓: select · ${primaryHint} · a: add · e: edit · d: delete`
                )}
            </Text>
        </Box>
    );
}

function ActionFooter({nav, hint}: {nav: ListNav; hint: string}): React.JSX.Element {
    return (
        <Box marginTop={1} flexDirection="column">
            {nav.actionError ? <Text color="red">⚠ {nav.actionError}</Text> : null}
            <Text dimColor>
                {nav.busy ? (
                    <>
                        <Spinner type="dots" /> applying…
                    </>
                ) : (
                    `↑/↓: select · ${hint}`
                )}
            </Text>
        </Box>
    );
}

/** Cap long lists so the panel never overflows; note what was cut. */
function capped<T>(items: T[]): {rows: T[]; more: number} {
    return {rows: items.slice(0, MAX_LIST_ROWS), more: Math.max(0, items.length - MAX_LIST_ROWS)};
}

function More({count}: {count: number}): React.JSX.Element | null {
    return count > 0 ? <Text dimColor>… and {count} more</Text> : null;
}

function Cursor({on}: {on: boolean}): React.JSX.Element {
    return on ? <Text color="yellow">› </Text> : <Text>{'  '}</Text>;
}

function EnabledDot({enabled}: {enabled: boolean}): React.JSX.Element {
    return enabled ? <Text color="green">● </Text> : <Text dimColor>○ </Text>;
}

export function Row({label, value}: {label: string; value: React.ReactNode}): React.JSX.Element {
    return (
        <Box>
            <Box width={22}>
                <Text dimColor>{label}</Text>
            </Box>
            <Text>{value}</Text>
        </Box>
    );
}

function Section({title}: {title: string}): React.JSX.Element {
    return (
        <Box marginTop={1}>
            <Text bold underline>
                {title}
            </Text>
        </Box>
    );
}

// ── Profile ─────────────────────────────────────────────────────────────────

/** Decode the JWT expiry locally (no verification — display only). */
function tokenExpiry(token?: string): Date | null {
    if (!token) return null;
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
        return typeof payload.exp === 'number' ? new Date(payload.exp * 1000) : null;
    } catch {
        return null;
    }
}

export function ProfileTab({cfg}: TabProps): React.JSX.Element {
    const state = useLoad(() => authApi.me(cfg));
    const profile = state.data;
    const expiry = tokenExpiry(cfg.token);
    return (
        <Status state={state}>
            <Box flexDirection="column">
                <Section title="Profile" />
                <Row label="Name" value={profile?.name ?? '–'} />
                <Row label="Email" value={profile?.email ?? '–'} />
                <Row
                    label="Role"
                    value={<Text color={profile?.role === 'admin' ? 'magenta' : undefined}>{profile?.role ?? '–'}</Text>}
                />
                {profile?.language ? <Row label="Language" value={profile.language} /> : null}
                {profile?.autoMemoryEnabled !== undefined ? (
                    <Row label="Auto-memory" value={profile.autoMemoryEnabled ? 'enabled' : 'disabled'} />
                ) : null}
                {profile?.maxHistoryTokens ? <Row label="Max history tokens" value={String(profile.maxHistoryTokens)} /> : null}
                {profile?.toolLoadingStrategy ? <Row label="Tool loading" value={profile.toolLoadingStrategy} /> : null}
                <Section title="Session" />
                <Row label="Backend" value={cfg.baseUrl} />
                <Row label="Token expires" value={expiry ? expiry.toLocaleString() : 'unknown'} />
            </Box>
        </Status>
    );
}

// ── LLM ─────────────────────────────────────────────────────────────────────

function llmFlags(config: LlmConfigDto): string {
    const parts: string[] = [];
    if (config.isDefault) parts.push('default');
    if (config.isSummarizer) parts.push('summarizer');
    if (config.isVision) parts.push('vision');
    return parts.join(', ');
}

export function LlmTab({cfg, onLockChange}: TabProps): React.JSX.Element {
    const state = useLoad(() => llmConfigsApi.list(cfg));
    const {rows, more} = capped(state.data ?? []);
    const crud = useCrudList({
        rows,
        isActive: !state.denied && !state.loading,
        onLockChange,
        primary: async (config) => {
            await llmConfigsApi.setDefault(cfg, config.id);
            state.setData((prev) => prev.map((c) => ({...c, isDefault: c.id === config.id})));
        },
        remove: (config) => llmConfigsApi.remove(cfg, config.id),
        deleteGuard: (all) => (all.length <= 1 ? 'Cannot delete the last remaining configuration.' : null),
        reload: state.reload,
    });

    if (crud.mode === 'form') return <LlmForm cfg={cfg} initial={crud.editing} onDone={crud.closeForm} />;

    return (
        <Status state={state}>
            <Box flexDirection="column">
                {rows.length === 0 ? <Text dimColor>No LLM configurations found — press a to add one.</Text> : null}
                {rows.map((config, index) => (
                    <Text key={config.id} wrap="truncate">
                        <Cursor on={index === crud.selected} />
                        {config.isDefault ? <Text color="yellow">★ </Text> : '  '}
                        <Text bold={config.isDefault}>{config.name}</Text>
                        <Text dimColor>
                            {'  '}
                            {config.provider}
                            {config.model ? ` · ${config.model}` : ''}
                            {config.maxTokens ? ` · ${config.maxTokens} tok` : ''}
                            {config.baseUrl ? ` · ${config.baseUrl}` : ''}
                        </Text>
                        {!config.hasApiKey && config.provider !== 'ollama' && config.provider !== 'lmstudio' ? (
                            <Text color="red"> (no API key)</Text>
                        ) : null}
                        {llmFlags(config) ? <Text color="cyan"> [{llmFlags(config)}]</Text> : null}
                    </Text>
                ))}
                <More count={more} />
                <CrudFooter crud={crud} rows={rows} nameOf={(c) => c.name} primaryHint="Enter: set default ★" />
            </Box>
        </Status>
    );
}

// ── Tools ───────────────────────────────────────────────────────────────────

export function ToolsTab({cfg, onLockChange}: TabProps): React.JSX.Element {
    const state = useLoad(() => resourcesApi.tools(cfg));
    const {rows, more} = capped(state.data ?? []);
    const crud = useCrudList({
        rows,
        isActive: !state.denied && !state.loading,
        onLockChange,
        primary: async (tool) => {
            const updated = await resourcesApi.toggleTool(cfg, tool.id);
            state.setData((prev) =>
                prev.map((t) => (t.id === tool.id ? {...t, enabled: updated?.enabled ?? !t.enabled} : t)),
            );
        },
        remove: (tool) => resourcesApi.removeTool(cfg, tool.id),
        reload: state.reload,
    });

    if (crud.mode === 'form') return <ToolForm cfg={cfg} initial={crud.editing} onDone={crud.closeForm} />;

    return (
        <Status state={state}>
            <Box flexDirection="column">
                {rows.length === 0 ? <Text dimColor>No custom tools visible to you — press a to add one.</Text> : null}
                {rows.map((tool, index) => (
                    <Text key={tool.id} wrap="truncate">
                        <Cursor on={index === crud.selected} />
                        <EnabledDot enabled={tool.enabled} />
                        <Text bold>{tool.name}</Text>
                        <Text color="cyan"> [{tool.executorType}]</Text>
                        <Text dimColor>
                            {' '}
                            {tool.scope}
                            {tool.description ? ` — ${tool.description}` : ''}
                        </Text>
                    </Text>
                ))}
                <More count={more} />
                <CrudFooter crud={crud} rows={rows} nameOf={(t) => t.name} primaryHint="Space: enable/disable" />
            </Box>
        </Status>
    );
}

// ── Skills ──────────────────────────────────────────────────────────────────

export function SkillsTab({cfg}: TabProps): React.JSX.Element {
    const state = useLoad(() => resourcesApi.skills(cfg));
    const {rows, more} = capped(state.data ?? []);
    const nav = useListNav(rows, async (skill) => {
        const updated = await resourcesApi.setSkillEnabled(cfg, skill.id, !skill.enabled);
        state.setData((prev) =>
            prev.map((s) => (s.id === skill.id ? {...s, enabled: updated?.enabled ?? !s.enabled} : s)),
        );
    });
    return (
        <Status state={state}>
            <Box flexDirection="column">
                {rows.length === 0 ? <Text dimColor>No skills installed.</Text> : null}
                {rows.map((skill, index) => (
                    <Text key={skill.id} wrap="truncate">
                        <Cursor on={index === nav.selected} />
                        <EnabledDot enabled={skill.enabled} />
                        <Text bold>{skill.name}</Text>
                        <Text dimColor> v{skill.version}</Text>
                        <Text color="cyan"> [{skill.kind}]</Text>
                        <Text dimColor> {skill.scope}</Text>
                        {skill.status && skill.status !== 'ready' ? <Text color="yellow"> {skill.status}</Text> : null}
                        {skill.description ? <Text dimColor> — {skill.description}</Text> : null}
                    </Text>
                ))}
                <More count={more} />
                {rows.length > 0 ? <ActionFooter nav={nav} hint="Space/Enter: enable/disable" /> : null}
            </Box>
        </Status>
    );
}

// ── Data sources ────────────────────────────────────────────────────────────

export function DataSourcesTab({cfg}: TabProps): React.JSX.Element {
    const state = useLoad(() => resourcesApi.dataSources(cfg));
    const {rows, more} = capped(state.data ?? []);
    return (
        <Status state={state}>
            <Box flexDirection="column">
                {rows.length === 0 ? <Text dimColor>No data sources visible to you.</Text> : null}
                {rows.map((source) => (
                    <Text key={source.id} wrap="truncate">
                        <Text bold>{source.name}</Text>
                        <Text color="cyan"> [{source.engine}]</Text>
                        <Text dimColor>
                            {' '}
                            {source.scope}
                            {source.description ? ` — ${source.description}` : ''}
                        </Text>
                    </Text>
                ))}
                <More count={more} />
            </Box>
        </Status>
    );
}

// ── MCP servers ─────────────────────────────────────────────────────────────

export function McpTab({cfg, onLockChange}: TabProps): React.JSX.Element {
    const state = useLoad(() => resourcesApi.mcpServers(cfg));
    const {rows, more} = capped(state.data ?? []);
    const crud = useCrudList({
        rows,
        isActive: !state.denied && !state.loading,
        onLockChange,
        primary: async (server) => {
            const updated = await resourcesApi.setMcpEnabled(cfg, server.id, !server.enabled);
            state.setData((prev) =>
                prev.map((s) => (s.id === server.id ? {...s, enabled: updated?.enabled ?? !s.enabled} : s)),
            );
        },
        remove: (server) => resourcesApi.removeMcp(cfg, server.id),
        reload: state.reload,
    });

    if (crud.mode === 'form') return <McpForm cfg={cfg} initial={crud.editing} onDone={crud.closeForm} />;

    return (
        <Status state={state}>
            <Box flexDirection="column">
                {rows.length === 0 ? <Text dimColor>No MCP servers configured — press a to add one.</Text> : null}
                {rows.map((server, index) => (
                    <Text key={server.id} wrap="truncate">
                        <Cursor on={index === crud.selected} />
                        <EnabledDot enabled={server.enabled} />
                        <Text bold>{server.name}</Text>
                        <Text color="cyan"> [{server.transport}]</Text>
                        <Text dimColor> {server.url ?? server.command ?? ''}</Text>
                        {server.description ? <Text dimColor> — {server.description}</Text> : null}
                    </Text>
                ))}
                <More count={more} />
                <CrudFooter crud={crud} rows={rows} nameOf={(s) => s.name} primaryHint="Space: enable/disable" />
            </Box>
        </Status>
    );
}

// ── Usage ───────────────────────────────────────────────────────────────────

const compact = new Intl.NumberFormat('en', {notation: 'compact', maximumFractionDigits: 1});

function tokens(group: TokenGroup): string {
    const cost = group.cost !== undefined ? `  $${group.cost.toFixed(3)}` : '';
    return `↑${compact.format(group.inputTokens)} ↓${compact.format(group.outputTokens)}  Σ${compact.format(group.totalTokens)}  ${group.messages} msg${cost}`;
}

export function UsageTab({cfg}: TabProps): React.JSX.Element {
    const isAdmin = cfg.user?.role === 'admin';
    const state = useLoad<UsageSummary>(() => (isAdmin ? resourcesApi.usageAll(cfg) : resourcesApi.usageMe(cfg)));
    const summary = state.data;
    const TOP = 8;
    return (
        <Status state={state}>
            <Box flexDirection="column">
                <Section title="Totals" />
                <Text>{summary ? tokens(summary.totals) : '–'}</Text>
                {summary && summary.byModel.length > 0 ? (
                    <>
                        <Section title="By model" />
                        {summary.byModel.slice(0, TOP).map((row, i) => (
                            <Row
                                key={i}
                                label={`${row.provider ?? '?'}/${row.model ?? '?'}`.slice(0, 21)}
                                value={<Text dimColor>{tokens(row)}</Text>}
                            />
                        ))}
                    </>
                ) : null}
                {summary?.byUser && summary.byUser.length > 0 ? (
                    <>
                        <Section title="By user" />
                        {summary.byUser.slice(0, TOP).map((row, i) => (
                            <Row key={i} label={(row.userName ?? '?').slice(0, 21)} value={<Text dimColor>{tokens(row)}</Text>} />
                        ))}
                    </>
                ) : null}
            </Box>
        </Status>
    );
}
