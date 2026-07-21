import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { filesApi, type FileRecord, type DocScope } from '../../api/files';
import { Download, Trash2, Brain, CheckCircle, Loader2, FileX, X } from 'lucide-react';

interface Props { chatId: string; projectId?: string | null; }

function fileIcon(mimeType: string) {
  if (mimeType === 'application/pdf') return '📄';
  if (mimeType.includes('word')) return '📝';
  if (mimeType.includes('sheet') || mimeType.includes('csv')) return '📊';
  if (mimeType.startsWith('image/')) return '🖼️';
  return '📎';
}

export default function FilePanel({ chatId, projectId }: Props) {
  const { t } = useTranslation('files');
  const qc = useQueryClient();

  /** ID of the file for which the collection selector is open */
  const [ingestFileId, setIngestFileId] = useState<string | null>(null);
  const [selectValue,  setSelectValue]  = useState('');
  const [scopeValue,   setScopeValue]   = useState<DocScope>('personal');

  const { data: files = [], isLoading } = useQuery({
    queryKey: ['files', 'chat', chatId],
    queryFn: () => filesApi.list({ chatId }),
    enabled: !!chatId,
  });

  const { data: collections = [], isLoading: collectionsLoading } = useQuery<string[]>({
    queryKey: ['embed-collections'],
    queryFn:  filesApi.listCollections,
    enabled:  ingestFileId !== null,
    staleTime: 30_000,
  });

  const ingest = useMutation({
    mutationFn: ({ fileId, collection, scope }: { fileId: string; collection?: string; scope: DocScope }) =>
      filesApi.ingest(fileId, { scope, collection: collection || undefined, projectId: projectId || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['files'] });
      closeIngest();
    },
  });

  const deleteFile = useMutation({
    mutationFn: (fileId: string) => filesApi.delete(fileId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['files'] }),
  });

  function openIngest(fileId: string) {
    setIngestFileId(fileId);
    setSelectValue('');
    // Sensible default: if the chat is in a project → project scope, otherwise personal.
    setScopeValue(projectId ? 'project' : 'personal');
  }

  function closeIngest() {
    setIngestFileId(null);
    setSelectValue('');
  }

  function confirmIngest() {
    if (!ingestFileId) return;
    ingest.mutate({ fileId: ingestFileId, collection: selectValue.trim() || undefined, scope: scopeValue });
  }

  if (isLoading) {
    return (
      <div className="p-4 flex items-center justify-center h-32">
        <Loader2 size={18} className="animate-spin text-gray-500" />
      </div>
    );
  }

  return (
    <div className="p-4 space-y-3">
      <h3 className="font-medium text-gray-200 text-sm">{t('panel.title')}</h3>

      {files.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <FileX size={28} className="text-gray-600 mb-2" />
          <p className="text-xs text-gray-600">{t('panel.empty')}</p>
          <p className="text-xs text-gray-700 mt-1">{t('panel.emptyHint')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {files.map((file: FileRecord) => {
            const isPendingThis   = ingest.isPending && ingest.variables?.fileId === file.id;
            const isSelectingThis = ingestFileId === file.id;

            return (
              <div key={file.id} className="bg-gray-800/60 rounded-lg p-3 group">
                {/* ── Main row ─── */}
                <div className="flex items-start gap-2">
                  <span className="text-lg flex-shrink-0">{fileIcon(file.mimeType)}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-gray-200 truncate">{file.originalName}</p>
                    <p className="text-xs text-gray-500">
                      {filesApi.formatSize(file.size)}
                      {file.vectorized && <span className="ml-2 text-green-500">· {t('panel.indexed')}</span>}
                    </p>
                  </div>

                  {file.vectorized ? (
                    <CheckCircle size={14} className="text-green-500 flex-shrink-0 mt-0.5" />
                  ) : isPendingThis ? (
                    <Brain size={14} className="text-teal-400 flex-shrink-0 mt-0.5 animate-pulse" />
                  ) : (
                    <button
                      onClick={() => openIngest(file.id)}
                      disabled={ingest.isPending || isSelectingThis}
                      className="text-gray-600 hover:text-teal-400 flex-shrink-0 mt-0.5 transition-colors"
                      title={t('panel.ingestTitle')}
                    >
                      <Brain size={14} />
                    </button>
                  )}
                </div>

                {/* ── Scope + collection selector ─── */}
                {isSelectingThis && (
                  <div className="mt-2.5 space-y-2">
                    {/* Scope: universal (company) | project | personal */}
                    <select
                      value={scopeValue}
                      onChange={(e) => setScopeValue(e.target.value as DocScope)}
                      className="w-full bg-gray-900 border border-gray-700 rounded-lg px-2.5 py-1.5
                        text-xs text-gray-200 focus:outline-none focus:border-teal-500 transition-colors"
                    >
                      <option value="universal">{t('panel.scopeUniversal')}</option>
                      <option value="project" disabled={!projectId}>{t('panel.scopeProject')}{projectId ? '' : t('panel.scopeProjectHint')}</option>
                      <option value="personal">{t('panel.scopePersonal')}</option>
                    </select>

                    {collectionsLoading ? (
                      <div className="flex items-center gap-1.5 text-xs text-gray-500 py-1">
                        <Loader2 size={11} className="animate-spin" /> {t('panel.loadingCollections')}
                      </div>
                    ) : (
                      <select
                        value={selectValue}
                        onChange={(e) => setSelectValue(e.target.value)}
                        className="w-full bg-gray-900 border border-gray-700 rounded-lg px-2.5 py-1.5
                          text-xs text-gray-200 focus:outline-none focus:border-teal-500 transition-colors"
                      >
                        <option value="">{t('panel.defaultCollection')}</option>
                        {collections.map((c) => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>
                    )}

                    <div className="flex gap-1.5">
                      <button
                        onClick={confirmIngest}
                        disabled={ingest.isPending || collectionsLoading}
                        className="flex-1 py-1.5 bg-teal-600 hover:bg-teal-500 disabled:opacity-50
                          text-white text-xs rounded-lg transition-colors flex items-center justify-center gap-1"
                      >
                        {ingest.isPending
                          ? <><Loader2 size={11} className="animate-spin" /> {t('panel.indexing')}</>
                          : <><Brain size={11} /> {t('panel.index')}</>
                        }
                      </button>
                      <button
                        onClick={closeIngest}
                        disabled={ingest.isPending}
                        className="px-2.5 py-1.5 text-gray-500 hover:text-gray-300
                          border border-gray-700 rounded-lg transition-colors"
                      >
                        <X size={12} />
                      </button>
                    </div>

                    <p className="text-xs text-gray-600 leading-tight">
                      {t('panel.defaultHintPre')} <em>{t('panel.defaultHintEm')}</em> {t('panel.defaultHintPost')}
                    </p>
                  </div>
                )}

                {/* ── Hover actions ─── */}
                <div className="flex gap-2 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => filesApi.download(file.id)}
                    className="text-xs text-gray-400 hover:text-gray-200 flex items-center gap-1 transition-colors"
                  >
                    <Download size={11} /> {t('panel.download')}
                  </button>
                  {!isSelectingThis && (
                    <button
                      onClick={() => openIngest(file.id)}
                      disabled={ingest.isPending}
                      className="text-xs text-gray-400 hover:text-teal-400 flex items-center gap-1 transition-colors"
                    >
                      <Brain size={11} /> {file.vectorized ? t('panel.reindex') : t('panel.index')}
                    </button>
                  )}
                  <button
                    onClick={() => deleteFile.mutate(file.id)}
                    disabled={deleteFile.isPending}
                    className="text-xs text-gray-400 hover:text-red-400 flex items-center gap-1 transition-colors"
                  >
                    <Trash2 size={11} /> {t('panel.delete')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
