/**
 * @file DataSourcesPage.tsx
 *
 * "Data sources" section in the settings.
 *
 * Structure:
 *   DataSourcesSection     — data source list + "New" button
 *   DataSourceCard         — single card (edit, delete, owner only)
 *   DataSourceModal        — create/edit form (side drawer)
 *   ├─ ConnessioneSection  — name, description, connectionString
 *   └─ SchemaSection       — schemaHints, prefetchRelations, scope
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Database, Plus, Loader2, X, Trash2, Lock, Globe, ArrowLeft,
  Users, ChevronDown, ChevronRight, CheckCircle, XCircle,
  AlertCircle, Eye, EyeOff, RefreshCw, Sparkles, Save, EyeOff as DenyIcon,
  Folder, FolderSearch, CornerLeftUp, File as FileIcon,
} from 'lucide-react';
import {
  dataSourcesApi,
  DATASOURCE_ENGINES,
  engineFamily,
  isDocumentManifest,
  isKeyspaceManifest,
  type DataSource,
  type DataSourceEngine,
  type CreateDataSourcePayload,
  type TestConnectionResult,
  type SchemaManifest,
  type SchemaManifestRelation,
  type DocumentManifest,
  type KeyspaceManifest,
  type FileEntry,
} from '../api/dataSources';
import { llmConfigsApi } from '../api/llmConfigs';
import { ScopeSelector, ScopeBadge } from '../components/ScopeSelector';
import { useStore } from '../store/useStore';

// ── Engine: labels and connection string format for the UI ────────────────────

const ENGINE_LABELS: Record<DataSourceEngine, string> = {
  postgres: 'PostgreSQL',
  mysql:    'MySQL',
  mariadb:  'MariaDB',
  mssql:    'SQL Server',
  oracle:   'Oracle',
  sqlite:   'SQLite',
  mongodb:  'MongoDB',
  redis:    'Redis',
  smb:      'SMB / CIFS (Samba)',
  sftp:     'SFTP',
  webdav:   'WebDAV',
};

const ENGINE_SCHEMES: Record<DataSourceEngine, string> = {
  postgres: 'postgresql://user:pass@host:5432/db',
  mysql:    'mysql://user:pass@host:3306/db',
  mariadb:  'mariadb://user:pass@host:3306/db',
  mssql:    'mssql://user:pass@host:1433/db',
  oracle:   'oracle://user:pass@host:1521/service',
  sqlite:   'sqlite:///path/to/file.db',
  mongodb:  'mongodb://user:pass@host:27017/db',
  redis:    'redis://:password@host:6379/0',
  smb:      'smb://[DOMAIN;]user:pass@host/share[/folder]',
  sftp:     'sftp://user:pass@host:22[/folder]',
  webdav:   'webdavs://user:pass@host[/folder]   (webdav:// for http)',
};

// ── Form-internal types ──────────────────────────────────────────────────────

interface FormState {
  name: string;
  description: string;
  engine: DataSourceEngine;
  connectionString: string;
  /** true = the connection is already saved on the server (write-only) */
  connectionStringSaved: boolean;
  showConnectionString: boolean;
  schemaHints: string;
  prefetchRelations: boolean;
  scope: 'personal' | 'team' | 'org';
  teamId: string | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function dataSourceToForm(ds: DataSource): FormState {
  return {
    name:                  ds.name,
    description:           ds.description ?? '',
    engine:                ds.engine,
    connectionString:      '',
    connectionStringSaved: true,
    showConnectionString:  false,
    schemaHints:           ds.schemaHints ?? '',
    prefetchRelations:     ds.prefetchRelations,
    scope:                 ds.scope,
    teamId:                ds.teamId,
  };
}

function emptyForm(): FormState {
  return {
    name:                  '',
    description:           '',
    engine:                'postgres',
    connectionString:      '',
    connectionStringSaved: false,
    showConnectionString:  false,
    schemaHints:           '',
    prefetchRelations:     false,
    scope:                 'personal',
    teamId:                null,
  };
}

// ── Supporting UI components ─────────────────────────────────────────────────

function Label({ children }: { children: React.ReactNode }) {
  return <label className="block text-xs font-medium text-gray-400 mb-1">{children}</label>;
}

function Input({
  value, onChange, placeholder, className = '', type = 'text', disabled = false,
}: {
  value: string; onChange: (v: string) => void; placeholder?: string;
  className?: string; type?: string; disabled?: boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      className={`w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200
        placeholder-gray-600 focus:outline-none focus:border-amber-500 disabled:opacity-50
        disabled:cursor-not-allowed transition-colors ${className}`}
    />
  );
}

function Textarea({
  value, onChange, placeholder, rows = 4, className = '', monospace = false,
}: {
  value: string; onChange: (v: string) => void; placeholder?: string;
  rows?: number; className?: string; monospace?: boolean;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      className={`w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200
        placeholder-gray-600 focus:outline-none focus:border-amber-500 resize-y transition-colors
        ${monospace ? 'font-mono text-xs' : ''} ${className}`}
    />
  );
}

// ── DataSourceCard ─────────────────────────────────────────────────────────────

function DataSourceCard({
  ds,
  onEdit,
}: {
  ds: DataSource;
  onEdit: () => void;
}) {
  const { t } = useTranslation('datasources');

  return (
    <div
      onClick={onEdit}
      className="flex items-start gap-3 px-4 py-3.5 hover:bg-gray-800/30 transition-colors cursor-pointer"
    >
      {/* Icon */}
      <div className="mt-0.5 flex-shrink-0 text-amber-500">
        <Database size={17} />
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-gray-200">{ds.name}</span>
          <ScopeBadge scope={ds.scope} />
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 font-medium">
            {ENGINE_LABELS[ds.engine] ?? ds.engine}
          </span>
        </div>
        {ds.description && (
          <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{ds.description}</p>
        )}
        <div className="flex items-center gap-1 mt-1">
          <Lock size={10} className="text-gray-600" />
          <span className="text-xs text-gray-600">{t('list.connectionEncrypted')}</span>
        </div>
      </div>
    </div>
  );
}

// ── ManifestEditor ──────────────────────────────────────────────────────────────
// Enriched schema editor: live introspection, AI generation (comments +
// relations) and manual editing (comments, deny flag, relations). Local state
// independent from the main form: it has dedicated endpoints (/introspect /enrich /manifest).

function ManifestEditor({
  dsId,
  initialManifest,
  registerPendingSave,
}: {
  dsId: string;
  initialManifest: SchemaManifest | DocumentManifest | KeyspaceManifest | null;
  /**
   * Hands the modal a way to flush the pending schema edits. The manifest has its own
   * endpoint and its own "save schema" button, so without this the modal's "Save" would
   * persist the form only and silently drop deny/comments/relations edited here.
   * Called with `null` when there is nothing to save.
   */
  registerPendingSave?: (save: (() => Promise<void>) | null) => void;
}) {
  const { t } = useTranslation('datasources');
  const qc = useQueryClient();
  const [manifest, setManifest] = useState<SchemaManifest | DocumentManifest | KeyspaceManifest | null>(initialManifest);
  const [error, setError]       = useState('');
  const [dirty, setDirty]       = useState(false);
  const [modelId, setModelId]   = useState('');   // '' = summarizer/default
  const [openTables, setOpenTables] = useState<Record<string, boolean>>({});

  // Configured models: the user picks the one suited to the enrichment
  // (for large schemas a capable model performs much better than a flash/summarizer).
  const { data: llmConfigs } = useQuery({
    queryKey: ['llm-configs'],
    queryFn: () => llmConfigsApi.list(),
  });

  const applyServer = (ds: DataSource) => {
    setManifest(ds.schemaManifest);
    setDirty(false);
    setError('');
    qc.invalidateQueries({ queryKey: ['data-sources'] });
  };
  const onErr = (err: any) =>
    setError(err.response?.data?.message || err.message || t('errors.operationFailed'));

  const introspectMut = useMutation({ mutationFn: () => dataSourcesApi.introspect(dsId), onSuccess: applyServer, onError: onErr });
  const enrichMut     = useMutation({ mutationFn: () => dataSourcesApi.enrich(dsId, modelId || undefined), onSuccess: applyServer, onError: onErr });
  const saveMut       = useMutation({
    mutationFn: () => dataSourcesApi.saveManifest(dsId, manifest!),
    onSuccess: applyServer,
    onError: onErr,
  });
  const clearMut      = useMutation({
    mutationFn: () => dataSourcesApi.clearManifest(dsId),
    onSuccess: applyServer,
    onError: onErr,
  });

  const busy = introspectMut.isPending || enrichMut.isPending || saveMut.isPending || clearMut.isPending;

  // Keep the modal in sync with the unsaved schema edits, so its "Save" can flush them too.
  const saveAsync = saveMut.mutateAsync;
  useEffect(() => {
    registerPendingSave?.(dirty ? () => saveAsync().then(() => undefined) : null);
    return () => registerPendingSave?.(null);
  }, [dirty, manifest, registerPendingSave, saveAsync]);

  // ── Local SQL mutators (non-destructive on the structure) ────────────────────
  const patchTable = (ti: number, patch: Partial<SchemaManifest['tables'][number]>) => {
    setManifest((m) => {
      if (!m || isDocumentManifest(m) || isKeyspaceManifest(m)) return m;
      const tables = m.tables.map((tbl, i) => (i === ti ? { ...tbl, ...patch } : tbl));
      return { ...m, tables };
    });
    setDirty(true);
  };
  const patchColumn = (ti: number, ci: number, patch: Partial<SchemaManifest['tables'][number]['columns'][number]>) => {
    setManifest((m) => {
      if (!m || isDocumentManifest(m) || isKeyspaceManifest(m)) return m;
      const tables = m.tables.map((tbl, i) => {
        if (i !== ti) return tbl;
        const columns = tbl.columns.map((c, j) => (j === ci ? { ...c, ...patch } : c));
        return { ...tbl, columns };
      });
      return { ...m, tables };
    });
    setDirty(true);
  };
  const patchRelation = (ri: number, patch: Partial<SchemaManifestRelation>) => {
    setManifest((m) => (m && !isDocumentManifest(m) && !isKeyspaceManifest(m))
      ? { ...m, relations: m.relations.map((r, i) => (i === ri ? { ...r, ...patch } : r)) } : m);
    setDirty(true);
  };
  const addRelation = () => {
    setManifest((m) => (m && !isDocumentManifest(m) && !isKeyspaceManifest(m))
      ? { ...m, relations: [...m.relations, { from: '', to: '', label: '' }] } : m);
    setDirty(true);
  };
  const removeRelation = (ri: number) => {
    setManifest((m) => (m && !isDocumentManifest(m) && !isKeyspaceManifest(m))
      ? { ...m, relations: m.relations.filter((_, i) => i !== ri) } : m);
    setDirty(true);
  };

  // ── Local Mongo mutators (collections/fields) ─────────────────────────────────
  const patchCollection = (ci: number, patch: Partial<DocumentManifest['collections'][number]>) => {
    setManifest((m) => (m && isDocumentManifest(m))
      ? { ...m, collections: m.collections.map((c, i) => (i === ci ? { ...c, ...patch } : c)) } : m);
    setDirty(true);
  };
  const patchField = (ci: number, fi: number, patch: Partial<DocumentManifest['collections'][number]['fields'][number]>) => {
    setManifest((m) => {
      if (!m || !isDocumentManifest(m)) return m;
      const collections = m.collections.map((c, i) => {
        if (i !== ci) return c;
        return { ...c, fields: c.fields.map((f, j) => (j === fi ? { ...f, ...patch } : f)) };
      });
      return { ...m, collections };
    });
    setDirty(true);
  };

  // ── Local Redis mutators (key patterns) ────────────────────────────────
  const patchPattern = (pi: number, patch: Partial<KeyspaceManifest['patterns'][number]>) => {
    setManifest((m) => (m && isKeyspaceManifest(m))
      ? { ...m, patterns: m.patterns.map((p, i) => (i === pi ? { ...p, ...patch } : p)) } : m);
    setDirty(true);
  };

  // ── Render ───────────────────────────────────────────────────────────────────
  const btn = 'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  // Manifests narrowed for rendering (narrowing of the SQL | document | keyspace union).
  const sqlM = manifest && !isDocumentManifest(manifest) && !isKeyspaceManifest(manifest) ? manifest : null;
  const docM = manifest && isDocumentManifest(manifest) ? manifest : null;
  const keyM = manifest && isKeyspaceManifest(manifest) ? manifest : null;

  return (
    <div className="space-y-3">
      {/* Actions */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => introspectMut.mutate()}
          disabled={busy}
          className={`${btn} bg-gray-800 text-gray-300 hover:bg-gray-700`}
        >
          {introspectMut.isPending ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          {t('manifest.introspectButton')}
        </button>
        <button
          onClick={() => enrichMut.mutate()}
          disabled={busy}
          className={`${btn} bg-amber-500/15 text-amber-300 hover:bg-amber-500/25`}
        >
          {enrichMut.isPending ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
          {t('manifest.generateAIButton')}
        </button>
        <select
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
          disabled={busy}
          title={t('manifest.modelTooltip')}
          className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-300
            focus:outline-none focus:border-amber-500 disabled:opacity-50 max-w-[180px]"
        >
          <option value="">
            {t('manifest.modelDefault')}
          </option>
          {(llmConfigs ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}{c.isSummarizer ? t('manifest.modelSuffix_summarizer') : c.isDefault ? t('manifest.modelSuffix_default') : ''}
            </option>
          ))}
        </select>
        {manifest && (
          <>
            <button
              onClick={() => saveMut.mutate()}
              disabled={busy || !dirty}
              className={`${btn} bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 ml-auto`}
            >
              {saveMut.isPending ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              {dirty ? t('manifest.saveSchema') : t('manifest.schemaSaved')}
            </button>
            <button
              onClick={() => { if (window.confirm(t('manifest.clearConfirm'))) clearMut.mutate(); }}
              disabled={busy}
              title={t('manifest.clearTooltip')}
              className={`${btn} text-red-400 hover:bg-red-500/10`}
            >
              {clearMut.isPending ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
              {t('manifest.clearButton')}
            </button>
          </>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-1.5 text-xs text-red-400">
          <AlertCircle size={12} /> {error}
        </div>
      )}

      {!manifest && !busy && (
        <p className="text-xs text-gray-600">
          {t('manifest.noSchema')}{' '}
          <span className="text-gray-400">{t('manifest.introspectPrompt')}</span>{' '}
          {t('manifest.noSchemaHint')}{' '}
          <span className="text-amber-400">{t('manifest.generateAIPrompt')}</span>{' '}
          {t('manifest.noSchemaHint2')}
        </p>
      )}

      {/* ── SQL manifest (relational) ── */}
      {sqlM && (
        <>
          <p className="text-xs text-gray-600">
            {t('manifest.stats', {
              tables: sqlM.tables.length,
              relations: sqlM.relations.length,
              dialect: sqlM.dialect,
              date: new Date(sqlM.generatedAt).toLocaleString(),
            })}
          </p>

          {/* Relations */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <Label>{t('manifest.relationsLabel')}</Label>
              <button onClick={addRelation} className="text-xs text-amber-400 hover:text-amber-300 flex items-center gap-1">
                <Plus size={11} /> {t('manifest.addRelation')}
              </button>
            </div>
            <div className="space-y-1.5">
              {sqlM.relations.map((r, ri) => (
                <div key={ri} className="flex items-center gap-1.5">
                  <Input value={r.from} onChange={(v) => patchRelation(ri, { from: v })} placeholder="table.column" className="text-xs font-mono flex-1 min-w-0" />
                  <span className="text-gray-600 text-xs flex-shrink-0">→</span>
                  <Input value={r.to} onChange={(v) => patchRelation(ri, { to: v })} placeholder="table.column" className="text-xs font-mono flex-1 min-w-0" />
                  <Input value={r.label ?? ''} onChange={(v) => patchRelation(ri, { label: v })} placeholder="note" className="text-xs flex-1 min-w-0" />
                  <button onClick={() => removeRelation(ri)} className="text-gray-600 hover:text-red-400 p-1">
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              {!sqlM.relations.length && <p className="text-xs text-gray-700">{t('manifest.noRelations')}</p>}
            </div>
          </div>

          {/* Tables */}
          <div>
            <Label>{t('manifest.tablesLabel')}</Label>
            <div className="space-y-1">
              {sqlM.tables.map((tbl, ti) => {
                const open = openTables[tbl.name];
                return (
                  <div key={tbl.name} className={`rounded-lg border ${tbl.deny ? 'border-red-900/40 bg-red-500/10' : 'border-gray-800 bg-gray-900'}`}>
                    <div className="flex items-center gap-2 px-2.5 py-2">
                      <button onClick={() => setOpenTables((s) => ({ ...s, [tbl.name]: !s[tbl.name] }))} className="text-gray-600 hover:text-gray-400">
                        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      </button>
                      <span className={`text-xs font-mono ${tbl.deny ? 'text-red-400 line-through' : 'text-gray-200'}`}>{tbl.name}</span>
                      <span className="text-xs text-gray-700">({tbl.columns.length})</span>
                      <input
                        value={tbl.comment}
                        onChange={(e) => patchTable(ti, { comment: e.target.value })}
                        placeholder={t('manifest.tableCommentPlaceholder')}
                        className="flex-1 bg-gray-800/50 border border-gray-700/60 rounded px-2 py-1 text-xs text-gray-300 placeholder-gray-600 hover:border-gray-600 focus:outline-none focus:border-amber-500 focus:bg-gray-800 transition-colors"
                      />
                      <button
                        onClick={() => patchTable(ti, { deny: !tbl.deny })}
                        title={tbl.deny ? t('manifest.denyAllow') : t('manifest.denyBlock')}
                        className={`p-1 rounded ${tbl.deny ? 'text-red-400 bg-red-500/10' : 'text-gray-600 hover:text-red-400'}`}
                      >
                        <DenyIcon size={12} />
                      </button>
                    </div>
                    {open && (
                      <div className="px-2.5 pb-2 space-y-1 border-t border-gray-800/60 pt-2">
                        {tbl.columns.map((c, ci) => (
                          <div key={c.name} className="flex items-center gap-2">
                            <span className={`text-xs font-mono w-40 truncate ${c.deny ? 'text-red-400 line-through' : 'text-gray-400'}`} title={`${c.name} (${c.type})`}>{c.name}</span>
                            <span className="text-[10px] text-gray-700 w-24 truncate">{c.type}</span>
                            <input
                              value={c.comment}
                              onChange={(e) => patchColumn(ti, ci, { comment: e.target.value })}
                              placeholder={t('manifest.columnCommentPlaceholder')}
                              className="flex-1 bg-gray-800/50 border border-gray-700/60 rounded px-2 py-1 text-xs text-gray-300 placeholder-gray-600 hover:border-gray-600 focus:outline-none focus:border-amber-500 focus:bg-gray-800 transition-colors"
                            />
                            <button
                              onClick={() => patchColumn(ti, ci, { deny: !c.deny })}
                              title={c.deny ? t('manifest.denyAllow') : t('manifest.denyColumnBlock')}
                              className={`p-1 rounded flex-shrink-0 ${c.deny ? 'text-red-400 bg-red-500/10' : 'text-gray-600 hover:text-red-400'}`}
                            >
                              <DenyIcon size={11} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* ── Document manifest (MongoDB) ── */}
      {docM && (
        <>
          <p className="text-xs text-gray-600">
            {t('manifest.statsDoc', {
              collections: docM.collections.length,
              date: new Date(docM.generatedAt).toLocaleString(),
            })}
          </p>
          <div>
            <Label>{t('manifest.collectionsLabel')}</Label>
            <div className="space-y-1">
              {docM.collections.map((coll, ci) => {
                const open = openTables[coll.name];
                return (
                  <div key={coll.name} className={`rounded-lg border ${coll.deny ? 'border-red-900/40 bg-red-500/10' : 'border-gray-800 bg-gray-900'}`}>
                    <div className="flex items-center gap-2 px-2.5 py-2">
                      <button onClick={() => setOpenTables((s) => ({ ...s, [coll.name]: !s[coll.name] }))} className="text-gray-600 hover:text-gray-400">
                        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      </button>
                      <span className={`text-xs font-mono ${coll.deny ? 'text-red-400 line-through' : 'text-gray-200'}`}>{coll.name}</span>
                      <span className="text-xs text-gray-700">({coll.fields.length})</span>
                      <input
                        value={coll.comment}
                        onChange={(e) => patchCollection(ci, { comment: e.target.value })}
                        placeholder={t('manifest.collectionCommentPlaceholder')}
                        className="flex-1 bg-gray-800/50 border border-gray-700/60 rounded px-2 py-1 text-xs text-gray-300 placeholder-gray-600 hover:border-gray-600 focus:outline-none focus:border-amber-500 focus:bg-gray-800 transition-colors"
                      />
                      <button
                        onClick={() => patchCollection(ci, { deny: !coll.deny })}
                        title={coll.deny ? t('manifest.denyAllow') : t('manifest.denyBlock')}
                        className={`p-1 rounded ${coll.deny ? 'text-red-400 bg-red-500/10' : 'text-gray-600 hover:text-red-400'}`}
                      >
                        <DenyIcon size={12} />
                      </button>
                    </div>
                    {open && (
                      <div className="px-2.5 pb-2 space-y-1 border-t border-gray-800/60 pt-2">
                        {coll.fields.map((f, fi) => (
                          <div key={f.path} className="flex items-center gap-2">
                            <span className={`text-xs font-mono w-40 truncate ${f.deny ? 'text-red-400 line-through' : 'text-gray-400'}`} title={`${f.path} (${f.types.join('|')})`}>{f.path}</span>
                            <span className="text-[10px] text-gray-700 w-24 truncate">{f.types.join('|')}{f.frequency < 1 ? ` ${Math.round(f.frequency * 100)}%` : ''}</span>
                            <input
                              value={f.comment}
                              onChange={(e) => patchField(ci, fi, { comment: e.target.value })}
                              placeholder={t('manifest.fieldCommentPlaceholder')}
                              className="flex-1 bg-gray-800/50 border border-gray-700/60 rounded px-2 py-1 text-xs text-gray-300 placeholder-gray-600 hover:border-gray-600 focus:outline-none focus:border-amber-500 focus:bg-gray-800 transition-colors"
                            />
                            <button
                              onClick={() => patchField(ci, fi, { deny: !f.deny })}
                              title={f.deny ? t('manifest.denyAllow') : t('manifest.denyColumnBlock')}
                              className={`p-1 rounded flex-shrink-0 ${f.deny ? 'text-red-400 bg-red-500/10' : 'text-gray-600 hover:text-red-400'}`}
                            >
                              <DenyIcon size={11} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* ── Keyspace manifest (Redis) ── */}
      {keyM && (
        <>
          <p className="text-xs text-gray-600">
            {t('manifest.statsKeyspace', {
              patterns: keyM.patterns.length,
              date: new Date(keyM.generatedAt).toLocaleString(),
            })}
          </p>
          <div>
            <Label>{t('manifest.patternsLabel')}</Label>
            <div className="space-y-1">
              {keyM.patterns.map((p, pi) => (
                <div key={p.pattern} className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 ${p.deny ? 'border-red-900/40 bg-red-500/10' : 'border-gray-800 bg-gray-900'}`}>
                  <span className={`text-xs font-mono ${p.deny ? 'text-red-400 line-through' : 'text-gray-200'}`} title={p.sampleKeys?.join(', ')}>{p.pattern}</span>
                  <span className="text-[10px] text-gray-700">{p.type} · ~{p.count}</span>
                  <input
                    value={p.comment}
                    onChange={(e) => patchPattern(pi, { comment: e.target.value })}
                    placeholder={t('manifest.patternCommentPlaceholder')}
                    className="flex-1 bg-gray-800/50 border border-gray-700/60 rounded px-2 py-1 text-xs text-gray-300 placeholder-gray-600 hover:border-gray-600 focus:outline-none focus:border-amber-500 focus:bg-gray-800 transition-colors"
                  />
                  <button
                    onClick={() => patchPattern(pi, { deny: !p.deny })}
                    title={p.deny ? t('manifest.denyAllow') : t('manifest.denyBlock')}
                    className={`p-1 rounded ${p.deny ? 'text-red-400 bg-red-500/10' : 'text-gray-600 hover:text-red-400'}`}
                  >
                    <DenyIcon size={12} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── DataSourceModal ────────────────────────────────────────────────────────────

function DataSourceEditor({
  ds,
  isAdmin,
  onClose,
}: {
  ds: DataSource | null;   // null = create new
  isAdmin: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation('datasources');
  const qc    = useQueryClient();
  const isEdit = !!ds?.id;
  const user  = useStore((s) => s.user);
  // A new source belongs to the current user; an existing one is deletable only by its owner.
  const isOwner = !ds || ds.userId === user?.id;

  const [form, setForm] = useState<FormState>(() =>
    ds ? dataSourceToForm(ds) : emptyForm(),
  );
  const [saveError, setSaveError] = useState('');
  const [savingManifest, setSavingManifest] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [savedId, setSavedId]     = useState<string | null>(ds?.id ?? null);
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null);
  const [testing, setTesting]       = useState(false);

  // Folder browser (file-share only)
  const [browseOpen, setBrowseOpen]       = useState(false);
  const [browsePath, setBrowsePath]       = useState('');
  const [browseEntries, setBrowseEntries] = useState<FileEntry[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError]     = useState('');

  // Collapsible sections
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({
    connessione: false,
    schema:      false,
  });
  const toggleSection = (s: string) =>
    setCollapsed((prev) => ({ ...prev, [s]: !prev[s] }));

  const set = useCallback(<K extends keyof FormState>(key: K, val: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: val }));
  }, []);

  const hasSaved = !!savedId;

  // ── Mutations ────────────────────────────────────────────────────────────────

  const createMut = useMutation({
    mutationFn: () => {
      const payload: CreateDataSourcePayload = {
        name:             form.name,
        engine:           form.engine,
        connectionString: form.connectionString,
        scope:            form.scope,
        teamId:           form.scope === 'team' ? form.teamId : null,
      };
      if (form.description.trim())  payload.description      = form.description.trim();
      if (form.schemaHints.trim())  payload.schemaHints      = form.schemaHints.trim();
      if (form.prefetchRelations)   payload.prefetchRelations = true;
      return dataSourcesApi.create(payload);
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ['data-sources'] });
      setSavedId(saved.id);
      setSaveError('');
      setForm(dataSourceToForm(saved));
    },
    onError: (err: any) => {
      setSaveError(err.response?.data?.message || err.message || t('errors.createFailed'));
    },
  });

  const updateMut = useMutation({
    mutationFn: () => {
      const payload: Partial<CreateDataSourcePayload> = {
        scope:  form.scope,
        teamId: form.scope === 'team' ? form.teamId : null,
      };
      if (form.engine !== ds?.engine) {
        payload.engine = form.engine;
      }
      if (form.description.trim() !== (ds?.description ?? '')) {
        payload.description = form.description.trim() || undefined;
      }
      if (form.connectionString.trim()) {
        payload.connectionString = form.connectionString.trim();
      }
      if (form.schemaHints.trim() !== (ds?.schemaHints ?? '')) {
        payload.schemaHints = form.schemaHints.trim() || undefined;
      }
      payload.prefetchRelations = form.prefetchRelations;
      return dataSourcesApi.update(savedId!, payload);
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ['data-sources'] });
      setSaveError('');
      setForm(dataSourceToForm(saved));
    },
    onError: (err: any) => {
      setSaveError(err.response?.data?.message || err.message || t('errors.updateFailed'));
    },
  });

  const deleteMut = useMutation({
    mutationFn: () => dataSourcesApi.remove(savedId!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['data-sources'] });
      onClose(); // back to the list
    },
    onError: (err: any) => {
      setSaveError(err.response?.data?.message || err.message || t('errors.deleteFailed'));
    },
  });

  const isSaving = createMut.isPending || updateMut.isPending || savingManifest;

  // Pending schema edits (deny/comments/relations) live in ManifestEditor, which has its
  // own endpoint. It registers a flush function here so that ONE "Save" persists both:
  // otherwise a hidden table is silently lost when the modal closes.
  const manifestSaveRef = useRef<(() => Promise<void>) | null>(null);
  const registerManifestSave = useCallback((save: (() => Promise<void>) | null) => {
    manifestSaveRef.current = save;
  }, []);

  async function handleSave() {
    setSaveError('');
    try {
      if (hasSaved) await updateMut.mutateAsync();
      else await createMut.mutateAsync();
    } catch {
      return; // the mutation's onError already surfaced the message
    }
    const flushManifest = manifestSaveRef.current;
    if (!flushManifest) return;
    setSavingManifest(true);
    try {
      await flushManifest();
    } catch (err: any) {
      setSaveError(err.response?.data?.message || err.message || t('errors.updateFailed'));
    } finally {
      setSavingManifest(false);
    }
  }

  // Closing with unsaved schema edits would drop them: ask first.
  function handleClose() {
    if (manifestSaveRef.current && !window.confirm(t('modal.unsavedSchemaConfirm'))) return;
    onClose();
  }

  // Test connection: uses the plaintext connection string if entered, otherwise
  // (if already saved) tries the server-side encrypted one.
  const canTest = !!form.connectionString.trim() || (hasSaved && form.connectionStringSaved);

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = form.connectionString.trim()
        ? await dataSourcesApi.testConnection(form.connectionString.trim(), form.engine)
        : await dataSourcesApi.testConnectionById(savedId!);
      setTestResult(res);
    } catch (err: any) {
      setTestResult({ ok: false, latencyMs: 0, message: err.response?.data?.message || err.message });
    } finally {
      setTesting(false);
    }
  }

  // ── Folder browser (file-share) ────────────────────────────────────────────
  const isFileShare = engineFamily(form.engine) === 'fileshare';
  // You can browse with the typed connection string (creation) or, if already
  // saved, using the server-side encrypted one.
  const canBrowse = isFileShare && (!!form.connectionString.trim() || (hasSaved && form.connectionStringSaved));
  // "Use this folder": on creation it appends to the connection string in the form;
  // on an already-saved source the string is not in the form → it is applied server-side.
  const canUseFolder = !!form.connectionString.trim() || (hasSaved && form.connectionStringSaved);

  async function loadBrowse(targetPath: string) {
    setBrowseLoading(true);
    setBrowseError('');
    try {
      const res = form.connectionString.trim()
        ? await dataSourcesApi.browse(form.connectionString.trim(), form.engine, targetPath)
        : await dataSourcesApi.browseById(savedId!, targetPath);
      setBrowsePath(res.path);
      setBrowseEntries(res.entries);
    } catch (err: any) {
      setBrowseError(err.response?.data?.message || err.message);
    } finally {
      setBrowseLoading(false);
    }
  }

  function openBrowse() {
    setBrowseOpen(true);
    setBrowsePath('');
    setBrowseEntries([]);
    setBrowseError('');
    void loadBrowse('');
  }

  function browseUp() {
    if (!browsePath) return;
    void loadBrowse(browsePath.split('/').slice(0, -1).join('/'));
  }

  async function useFolder() {
    // Creation / typed string: appends into the form (no persistence here).
    if (form.connectionString.trim()) {
      const base = form.connectionString.trim().replace(/\/+$/, '');
      set('connectionString', browsePath ? `${base}/${browsePath}` : base);
      setBrowseOpen(false);
      setTestResult(null);
      return;
    }
    // Saved source: the plaintext string is not in the form → apply server-side.
    if (hasSaved && savedId) {
      try {
        await dataSourcesApi.setBase(savedId, browsePath);
        qc.invalidateQueries({ queryKey: ['data-sources'] });
        setBrowseOpen(false);
      } catch (err: any) {
        setBrowseError(err.response?.data?.message || err.message);
      }
    }
  }

  const canSave = !!form.name.trim() &&
    (hasSaved || !!form.connectionString.trim());

  // ── Render ───────────────────────────────────────────────────────────────────

  const CollapsibleHeader = ({ section, label }: { section: string; label: string }) => (
    <button
      onClick={() => toggleSection(section)}
      className="w-full flex items-center gap-2 py-1 group"
    >
      {collapsed[section]
        ? <ChevronRight size={12} className="text-gray-600 group-hover:text-gray-400" />
        : <ChevronDown  size={12} className="text-gray-600 group-hover:text-gray-400" />
      }
      <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">{label}</span>
      <div className="flex-1 h-px bg-gray-800" />
    </button>
  );

  return (
    <div>
      {/* Panel — inline, replaces the list (Flows-style) */}
      <div>
        {/* Header with back button */}
        <div className="flex items-center gap-3 mb-5">
          <button
            onClick={handleClose}
            className="text-gray-400 hover:text-white flex items-center gap-1 text-sm flex-shrink-0"
          >
            <ArrowLeft size={16} /> {t('section.title')}
          </button>
          <div className="flex items-center gap-2.5 min-w-0">
            <Database size={16} className="text-amber-400 flex-shrink-0" />
            <h2 className="text-sm font-semibold text-gray-100 truncate">
              {hasSaved
                ? t('modal.titleEdit', { name: form.name })
                : t('modal.titleNew')}
            </h2>
            {hasSaved && (
              <span className="text-xs text-gray-600 font-mono flex-shrink-0">#{savedId!.slice(0, 8)}</span>
            )}
          </div>
        </div>

        {/* Body — overflow-x-hidden: wide contents (relations editor) must not scroll sideways */}
        <div className="space-y-4 overflow-x-hidden">

          {/* ── Connection ────────────────────────────────────────────────── */}
          <CollapsibleHeader section="connessione" label={t('modal.sectionConnection')} />
          {!collapsed.connessione && (
            <div className="space-y-3">

              {/* Name */}
              <div>
                <Label>
                  {t('form.nameLabel')}{' '}
                  <span className="text-gray-600 font-normal">{t('form.nameHint')}</span>
                </Label>
                <Input
                  value={form.name}
                  onChange={(v) => set('name', v)}
                  placeholder={t('form.namePlaceholder')}
                  disabled={isEdit && hasSaved}
                />
              </div>

              {/* Description */}
              <div>
                <Label>
                  {t('form.descriptionLabel')}{' '}
                  <span className="text-gray-600 font-normal">{t('form.descriptionHint')}</span>
                </Label>
                <Textarea
                  value={form.description}
                  onChange={(v) => set('description', v)}
                  placeholder={t('form.descriptionPlaceholder')}
                  rows={3}
                />
              </div>

              {/* Engine (DBMS) */}
              <div>
                <Label>{t('form.engineLabel')}</Label>
                <select
                  value={form.engine}
                  onChange={(e) => { set('engine', e.target.value as DataSourceEngine); setTestResult(null); }}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm
                    text-gray-200 focus:outline-none focus:border-amber-500 transition-colors"
                >
                  {DATASOURCE_ENGINES.map((e) => (
                    <option key={e} value={e}>{ENGINE_LABELS[e]}</option>
                  ))}
                </select>
              </div>

              {/* Connection String — write-only */}
              <div>
                <Label>
                  {t('form.connectionStringLabel')}{' '}
                  <span className="text-gray-600 font-normal">{t('form.connectionStringHint')}</span>
                </Label>
                <div className="relative">
                  <input
                    type={form.showConnectionString ? 'text' : 'password'}
                    value={form.connectionString}
                    onChange={(e) => set('connectionString', e.target.value)}
                    placeholder={
                      form.connectionStringSaved
                        ? t('form.connectionStringSavedPlaceholder')
                        : t('form.connectionStringNewPlaceholder')
                    }
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 pr-10 py-2 text-sm
                      text-gray-200 placeholder-gray-600 focus:outline-none focus:border-amber-500 transition-colors"
                  />
                  <button
                    type="button"
                    onClick={() => set('showConnectionString', !form.showConnectionString)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-600 hover:text-gray-400 transition-colors"
                  >
                    {form.showConnectionString ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
                {form.connectionStringSaved && !form.connectionString && (
                  <p className="text-xs text-gray-600 mt-1 flex items-center gap-1">
                    <Lock size={10} /> {t('form.connectionStringSavedNote')}
                  </p>
                )}
                <p className="text-xs text-gray-600 mt-1">
                  {t('form.formatLabel')}{' '}
                  <code className="text-gray-500">{ENGINE_SCHEMES[form.engine]}</code>
                </p>

                {/* Test connection */}
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleTest}
                    disabled={!canTest || testing}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-gray-700
                      text-gray-300 hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {testing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                    {t('form.testConnection')}
                  </button>
                  {isFileShare && (
                    <button
                      type="button"
                      onClick={openBrowse}
                      disabled={!canBrowse}
                      title={t('browse.button')}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-gray-700
                        text-gray-300 hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      <FolderSearch size={12} />
                      {t('browse.button')}
                    </button>
                  )}
                  {testResult && (
                    <span className={`text-xs flex items-center gap-1 ${testResult.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                      {testResult.ok
                        ? <><CheckCircle size={12} /> {t('form.testOk', { ms: testResult.latencyMs })}</>
                        : <><XCircle size={12} /> {testResult.message || t('form.testFailed')}</>}
                    </span>
                  )}
                </div>

                {/* Folder browser modal (file-share) */}
                {browseOpen && (
                  <div
                    className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
                    onClick={() => setBrowseOpen(false)}
                  >
                    <div
                      className="w-full max-w-lg max-h-[80vh] flex flex-col bg-gray-900 border border-gray-700 rounded-xl shadow-xl"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
                        <div className="flex items-center gap-2 text-sm font-medium text-gray-200">
                          <FolderSearch size={15} /> {t('browse.title')}
                        </div>
                        <button type="button" onClick={() => setBrowseOpen(false)} className="text-gray-500 hover:text-gray-300">
                          <X size={16} />
                        </button>
                      </div>

                      <div className="px-4 py-2 border-b border-gray-800 flex items-center gap-2 text-xs">
                        <button
                          type="button"
                          onClick={browseUp}
                          disabled={!browsePath || browseLoading}
                          className="flex items-center gap-1 px-1.5 py-1 rounded border border-gray-700 text-gray-300
                            hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <CornerLeftUp size={12} /> {t('browse.up')}
                        </button>
                        <code className="text-gray-500 truncate">/{browsePath}</code>
                      </div>

                      <div className="flex-1 overflow-y-auto px-2 py-2 min-h-[160px]">
                        {browseLoading ? (
                          <div className="flex items-center justify-center gap-2 py-8 text-sm text-gray-500">
                            <Loader2 size={14} className="animate-spin" /> {t('browse.loading')}
                          </div>
                        ) : browseError ? (
                          <div className="flex items-start gap-2 px-2 py-4 text-xs text-red-400">
                            <AlertCircle size={14} className="shrink-0" /> {browseError}
                          </div>
                        ) : browseEntries.length === 0 ? (
                          <div className="py-8 text-center text-sm text-gray-600">{t('browse.empty')}</div>
                        ) : (
                          <ul className="space-y-0.5">
                            {browseEntries.filter((e) => e.type === 'dir').map((e) => (
                              <li key={e.path}>
                                <button
                                  type="button"
                                  onClick={() => loadBrowse(e.path)}
                                  className="w-full flex items-center gap-2 px-2 py-1.5 text-sm text-gray-200 rounded hover:bg-gray-800 text-left"
                                >
                                  <Folder size={14} className="text-amber-400 shrink-0" />
                                  <span className="truncate">{e.name}</span>
                                  <ChevronRight size={13} className="ml-auto text-gray-600 shrink-0" />
                                </button>
                              </li>
                            ))}
                            {browseEntries.filter((e) => e.type === 'file').map((e) => (
                              <li key={e.path} className="flex items-center gap-2 px-2 py-1.5 text-sm text-gray-500">
                                <FileIcon size={14} className="shrink-0" />
                                <span className="truncate">{e.name}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>

                      <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-gray-800">
                        <span className="text-xs text-gray-500 truncate">
                          {t('browse.current')} <code className="text-gray-400">/{browsePath}</code>
                        </span>
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={() => setBrowseOpen(false)}
                            className="px-2.5 py-1.5 text-xs rounded-lg border border-gray-700 text-gray-300 hover:bg-gray-800"
                          >
                            {t('browse.cancel')}
                          </button>
                          <button
                            type="button"
                            onClick={useFolder}
                            disabled={!canUseFolder}
                            title={canUseFolder ? '' : t('browse.useNeedsConn')}
                            className="px-2.5 py-1.5 text-xs rounded-lg bg-amber-600 text-white hover:bg-amber-500
                              disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            {t('browse.use')}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Schema ─────────────────────────────────────────────────────── */}
          <CollapsibleHeader section="schema" label={t('modal.sectionSchema')} />
          {!collapsed.schema && (
            <div className="space-y-3">

              {/* Schema hints */}
              <div>
                <Label>
                  {t('form.schemaHintsLabel')}{' '}
                  <span className="text-gray-600 font-normal">{t('form.schemaHintsHint')}</span>
                </Label>
                <Textarea
                  value={form.schemaHints}
                  onChange={(v) => set('schemaHints', v)}
                  placeholder={t('form.schemaHintsPlaceholder')}
                  rows={7}
                  monospace
                />
                <p className="text-xs text-gray-600 mt-1">
                  {t('form.schemaHintsNote')}
                </p>
              </div>

              {/* Prefetch Relations */}
              <div className="bg-gray-900 rounded-lg px-3 py-3">
                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.prefetchRelations}
                    onChange={(e) => set('prefetchRelations', e.target.checked)}
                    className="mt-0.5 accent-amber-500"
                  />
                  <div>
                    <span className="text-xs font-medium text-gray-300">{t('form.prefetchRelationsLabel')}</span>
                    <p className="text-xs text-gray-600 leading-tight mt-0.5">
                      {t('form.prefetchRelationsHint')}
                    </p>
                  </div>
                </label>
              </div>

              {/* Enriched schema (manifest) — not applicable to file-shares (no schema) */}
              {engineFamily(form.engine) !== 'fileshare' && (
                <div className="border-t border-gray-800 pt-3">
                  <Label>
                    {t('form.enrichedSchemaLabel')}{' '}
                    <span className="text-gray-600 font-normal">{t('form.enrichedSchemaHint')}</span>
                  </Label>
                  {hasSaved ? (
                    <ManifestEditor
                      key={savedId!}
                      dsId={savedId!}
                      initialManifest={ds?.schemaManifest ?? null}
                      registerPendingSave={registerManifestSave}
                    />
                  ) : (
                    <p className="text-xs text-gray-600">
                      {t('form.enrichedSchemaSaveFirst')}
                    </p>
                  )}
                </div>
              )}

              {/* Scope: personal / team / org (org reserved for admins) */}
              <div>
                <Label>{t('form.visibilityLabel')}</Label>
                <ScopeSelector
                  scope={form.scope}
                  teamId={form.teamId}
                  onScope={(s) => set('scope', s)}
                  onTeam={(id) => set('teamId', id)}
                  allowOrg={isAdmin}
                />
              </div>

              {/* Security warning info */}
              {/* Translucent tint + remapped text: the dark shades (amber-950/900, and any
                  class with an opacity suffix) are not remapped in the light theme. */}
              <div className="flex items-start gap-2 text-xs text-amber-400 bg-amber-500/15
                border border-amber-500/30 rounded-lg px-2.5 py-2">
                <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
                <span>
                  {t('form.securityNote')}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-gray-800 mt-6 pt-4 flex items-center gap-3">
          {/* Delete — owner only, existing source only */}
          {isOwner && hasSaved && (
            confirmDelete ? (
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="text-xs text-gray-400">{t('card.titleDelete')}?</span>
                <button
                  onClick={() => deleteMut.mutate()}
                  disabled={deleteMut.isPending}
                  className="px-2 py-1 text-xs bg-red-600 hover:bg-red-500 text-white rounded transition-colors"
                >
                  {deleteMut.isPending ? <Loader2 size={12} className="animate-spin" /> : t('card.confirmDelete')}
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="px-2 py-1 text-xs text-gray-400 hover:text-gray-200 rounded"
                >
                  {t('card.cancelDelete')}
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                title={t('card.titleDelete')}
                className="flex items-center gap-1.5 px-2.5 py-2 text-sm text-gray-400 hover:text-red-400 rounded-lg transition-colors flex-shrink-0"
              >
                <Trash2 size={15} /> {t('card.confirmDelete')}
              </button>
            )
          )}
          <div className="min-w-0 flex-1 pr-4">
            {saveError && (
              <div className="flex items-center gap-1.5 text-xs text-red-400">
                <XCircle size={13} />
                <span className="truncate">{saveError}</span>
              </div>
            )}
            {(createMut.isSuccess || updateMut.isSuccess) && !saveError && (
              <div className="flex items-center gap-1.5 text-xs text-emerald-400">
                <CheckCircle size={13} />
                {t('modal.saved')}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={handleClose}
              className="px-3 py-2 text-sm text-gray-400 hover:text-gray-200 rounded-lg transition-colors"
            >
              {hasSaved ? t('modal.closeSaved') : t('common:actions.cancel')}
            </button>
            <button
              onClick={handleSave}
              disabled={isSaving || !canSave}
              className="flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-500
                disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium
                rounded-lg transition-colors"
            >
              {isSaving ? <Loader2 size={14} className="animate-spin" /> : null}
              {isSaving ? t('modal.saving') : hasSaved ? t('modal.saveChanges') : t('modal.createSource')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── DataSourcesSection (export) ───────────────────────────────────────────────

export function DataSourcesSection() {
  const { t } = useTranslation('datasources');
  const qc      = useQueryClient();
  const user    = useStore((s) => s.user);
  const isAdmin = user?.role === 'admin';

  const [showModal, setShowModal]   = useState(false);
  const [editingDs, setEditingDs]   = useState<DataSource | null>(null);

  const { data: dataSources = [], isLoading } = useQuery({
    queryKey: ['data-sources'],
    queryFn:  dataSourcesApi.list,
  });

  const openCreate = () => { setEditingDs(null); setShowModal(true); };
  const openEdit   = (ds: DataSource) => { setEditingDs(ds); setShowModal(true); };
  const closeModal = () => { setShowModal(false); setEditingDs(null); };

  const personalCount = dataSources.filter((ds) => ds.scope === 'personal').length;
  const sharedCount   = dataSources.filter((ds) => ds.scope !== 'personal').length;

  // Editor replaces the list in-place (Flows-style) instead of a right drawer.
  if (showModal) {
    return <DataSourceEditor ds={editingDs} isAdmin={isAdmin} onClose={closeModal} />;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-white">{t('section.title')}</h2>
          <p className="text-sm text-gray-500 mt-1 leading-relaxed">
            {t('section.description')}
          </p>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-2 px-3.5 py-2 bg-amber-600 hover:bg-amber-500
            text-white text-sm font-medium rounded-lg transition-colors flex-shrink-0"
        >
          <Plus size={15} />
          {t('section.newButton')}
        </button>
      </div>

      {/* Stats */}
      {dataSources.length > 0 && (
        <div className="flex items-center gap-4 text-xs text-gray-500">
          <div className="flex items-center gap-1.5">
            <Globe size={12} className="text-amber-400" />
            <span>{t('stats.total', { count: dataSources.length })}</span>
          </div>
          {personalCount > 0 && (
            <>
              <span>·</span>
              <span className="flex items-center gap-1 text-blue-400">
                <Lock size={10} /> {t('stats.personal', { count: personalCount })}
              </span>
            </>
          )}
          {sharedCount > 0 && (
            <>
              <span>·</span>
              <span className="flex items-center gap-1 text-purple-400">
                <Users size={10} /> {sharedCount} {t('stats.shared')}
              </span>
            </>
          )}
        </div>
      )}

      {/* Sources list */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center py-10 gap-2 text-gray-600 text-sm">
            <Loader2 size={16} className="animate-spin" />
            {t('list.loading')}
          </div>
        ) : dataSources.length === 0 ? (
          <div className="py-14 text-center space-y-3">
            <div className="w-12 h-12 bg-gray-800 rounded-2xl flex items-center justify-center mx-auto">
              <Database size={22} className="text-gray-600" />
            </div>
            <div>
              <p className="text-sm text-gray-400">{t('list.empty.title')}</p>
              <p className="text-xs text-gray-600 mt-1">
                {t('list.empty.hint')}
              </p>
            </div>
            <button
              onClick={openCreate}
              className="inline-flex items-center gap-1.5 text-sm text-amber-400 hover:text-amber-300 transition-colors"
            >
              <Plus size={14} /> {t('list.empty.add')}
            </button>
          </div>
        ) : (
          <div className="divide-y divide-gray-800">
            {dataSources.map((ds) => (
              <DataSourceCard
                key={ds.id}
                ds={ds}
                onEdit={() => openEdit(ds)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Security note */}
      {dataSources.length > 0 && (
        <div className="bg-gray-900/60 border border-gray-800/60 rounded-xl px-4 py-3 space-y-1">
          <p className="text-xs font-medium text-gray-500">{t('security.title')}</p>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-gray-600">
            <Lock size={11} className="text-amber-500 mt-0.5" />
            <span>{t('security.encryption')}</span>
            <Database size={11} className="text-amber-500 mt-0.5" />
            <span>{t('security.queryOnDemand')}</span>
            <Users size={11} className="text-amber-500 mt-0.5" />
            <span>{t('security.sharedAccess')}</span>
          </div>
        </div>
      )}

    </div>
  );
}
