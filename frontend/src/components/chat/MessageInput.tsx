import { useState, useRef, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useDropzone } from 'react-dropzone';
import { filesApi, type FileRecord, type DocScope } from '../../api/files';
import { transcriptionApi } from '../../api/transcription';
import { Send, Paperclip, X, Loader2, Brain, FileText, ChevronLeft, AlertCircle, Mic, Square } from 'lucide-react';

type AttachmentMode = 'embed' | 'inline' | 'attachment';

/**
 * Types that the Claude API accepts as native content blocks (images and PDF).
 * Used for the "Native attachment" button with direct rendering by the model.
 */
const CLAUDE_NATIVE_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/**
 * Returns true if the backend is able to extract text from the file
 * (used for "Embed in RAG" and "Extracted text").
 * Matches the cases handled by FilesService.extractText().
 */
function canExtractText(mimeType: string): boolean {
  if (!mimeType) return false;
  if (mimeType.startsWith('text/')) return true;
  if (CLAUDE_NATIVE_TYPES.includes(mimeType)) return true;
  return [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
  ].includes(mimeType);
}

interface Attachment {
  name: string;
  fileId: string;
  mimeType: string;
  mode: AttachmentMode;
}

interface PendingFile {
  record: FileRecord;
  originalName: string;
}

interface Props {
  onSend: (content: string, attachments: Attachment[]) => void;
  disabled: boolean;
  chatId: string;
  /** Current chat's project: determines where to upload files and the "project" scope. */
  projectId?: string | null;
}

export default function MessageInput({ onSend, disabled, chatId, projectId }: Props) {
  const { t, i18n } = useTranslation('chat');
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [pendingFile, setPendingFile] = useState<PendingFile | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  /** true = we are showing the collection picker (step 2 of "Embed in RAG") */
  const [collectionPickerOpen, setCollectionPickerOpen] = useState(false);
  const [selectedCollection, setSelectedCollection] = useState('');
  const [selectedScope, setSelectedScope] = useState<DocScope>('personal');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { data: collections = [], isLoading: collectionsLoading } = useQuery<string[]>({
    queryKey: ['embed-collections'],
    queryFn:  filesApi.listCollections,
    enabled:  collectionPickerOpen,
    staleTime: 30_000,
  });

  // ── Voice input (Whisper) ──────────────────────────────────────────────────
  const { data: voiceStatus } = useQuery({
    queryKey: ['transcription-status'],
    queryFn:  transcriptionApi.status,
    staleTime: 5 * 60_000,
  });
  const voiceEnabled = voiceStatus?.enabled ?? false;

  const [recording, setRecording]       = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef   = useRef<Blob[]>([]);
  const audioStreamRef   = useRef<MediaStream | null>(null);

  /** Stops the recording and releases the microphone. */
  const stopStream = useCallback(() => {
    audioStreamRef.current?.getTracks().forEach((tr) => tr.stop());
    audioStreamRef.current = null;
  }, []);

  // Cleanup on unmount: do not leave the microphone active
  useEffect(() => stopStream, [stopStream]);

  const startRecording = useCallback(async () => {
    setUploadError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioStreamRef.current = stream;
      audioChunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        stopStream();
        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        audioChunksRef.current = [];
        if (blob.size === 0) { setTranscribing(false); return; }
        try {
          setTranscribing(true);
          const lang = (i18n.language || '').slice(0, 2);
          const transcript = (await transcriptionApi.transcribe(blob, lang)).trim();
          if (transcript) {
            setText((prev) => (prev.trim() ? `${prev.trim()} ${transcript}` : transcript));
            requestAnimationFrame(() => { adjustHeight(); textareaRef.current?.focus(); });
          }
        } catch (err: any) {
          setUploadError(err?.response?.data?.message || t('voice.error'));
        } finally {
          setTranscribing(false);
        }
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setRecording(true);
    } catch {
      stopStream();
      setUploadError(t('voice.micDenied'));
    }
  }, [i18n.language, stopStream, t]);

  const stopRecording = useCallback(() => {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    setRecording(false);
  }, []);

  const toggleRecording = useCallback(() => {
    if (recording) stopRecording();
    else startRecording();
  }, [recording, startRecording, stopRecording]);

  // Auto-dismiss the error toast after 5 seconds
  useEffect(() => {
    if (!uploadError) return;
    const t = setTimeout(() => setUploadError(null), 5000);
    return () => clearTimeout(t);
  }, [uploadError]);

  const onDrop = useCallback(async (files: File[]) => {
    setUploading(true);
    setUploadError(null);
    try {
      for (const file of files) {
        const record = await filesApi.upload(file, { projectId: projectId || undefined });
        setPendingFile({ record, originalName: file.name });
      }
    } catch (err: any) {
      console.error('Upload error:', err);
      const msg =
        err?.response?.data?.message ||
        err?.message ||
        t('uploadError');
      setUploadError(msg);
    } finally {
      setUploading(false);
    }
  }, [projectId]);

  const { getRootProps, getInputProps, open } = useDropzone({
    onDrop,
    noClick: true,
    noKeyboard: true,
  });

  const confirmMode = (mode: AttachmentMode, collection?: string, scope: DocScope = 'personal') => {
    if (!pendingFile) return;

    const attachment: Attachment = {
      name:     pendingFile.originalName,
      fileId:   pendingFile.record.id,
      mimeType: pendingFile.record.mimeType,
      mode,
    };

    if (mode === 'embed') {
      // Start the indexing and send an automatic informative message so the
      // event (file name, fileId, scope, collection) is persisted in the chat
      // history and the LLM knows the document is in the knowledge base.
      // It must NOT ask the LLM to confirm/verify anything: the agent has no
      // tool to check the ingestion and would reply that it cannot.
      filesApi.ingest(pendingFile.record.id, {
        scope,
        collection: collection || undefined,
        projectId: projectId || undefined,
      }).catch(() => {});

      const scopeLabel = t(
        scope === 'universal' ? 'embedMsg.scopeUniversal'
        : scope === 'project' ? 'embedMsg.scopeProject'
        : 'embedMsg.scopePersonal',
      );
      onSend(
        t('embedMsg.text', {
          name:       pendingFile.originalName,
          fileId:     pendingFile.record.id,
          scope:      scopeLabel,
          collection: collection ? t('embedMsg.collectionSuffix', { collection }) : '',
        }),
        [attachment],
      );

      setPendingFile(null);
      setCollectionPickerOpen(false);
      setSelectedCollection('');
      return;
    }

    // attachment and inline: the file stays queued as a chip — the user writes and sends
    setAttachments((prev) => [...prev, attachment]);
    setPendingFile(null);
    setCollectionPickerOpen(false);
    setSelectedCollection('');
  };

  const cancelPending = () => {
    setPendingFile(null);
    setCollectionPickerOpen(false);
    setSelectedCollection('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSend = () => {
    const content = text.trim();
    if (!content || disabled) return;
    onSend(content, attachments);
    setText('');
    setAttachments([]);
  };

  const adjustHeight = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  };

  return (
    <div {...getRootProps()} className="relative">
      <input {...getInputProps()} />

      {/* Upload error toast */}
      {uploadError && (
        <div className="mb-3 flex items-start gap-2.5 bg-red-950/80 border border-red-800/60 rounded-xl px-3.5 py-2.5 shadow-lg animate-in slide-in-from-bottom-2 duration-200">
          <AlertCircle size={15} className="text-red-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-red-300 flex-1 leading-relaxed">{uploadError}</p>
          <button onClick={() => setUploadError(null)} className="text-red-600 hover:text-red-400 transition-colors flex-shrink-0">
            <X size={13} />
          </button>
        </div>
      )}

      {/* File mode selection dialog */}
      {pendingFile && (
        <div className="mb-3 bg-gray-800 border border-gray-700 rounded-xl p-4 shadow-xl">
          {!collectionPickerOpen ? (
            /* ── Step 1: choose mode ── */
            <>
              <p className="text-xs text-gray-400 mb-3">
                Come vuoi usare <span className="text-gray-200 font-medium">"{pendingFile.originalName}"</span>?
              </p>

              {/* Buttons contextual to the file type */}
              <div className={`grid gap-2 ${canExtractText(pendingFile.record.mimeType) ? 'grid-cols-3' : 'grid-cols-1'}`}>
                {canExtractText(pendingFile.record.mimeType) && (
                  <>
                    <button
                      onClick={() => { setSelectedScope(projectId ? 'project' : 'personal'); setCollectionPickerOpen(true); }}
                      className="flex flex-col items-start gap-1.5 p-3 bg-blue-600/10 hover:bg-blue-600/20 border border-blue-600/30 hover:border-blue-500/60 rounded-lg transition-colors text-left"
                    >
                      <div className="flex items-center gap-1.5">
                        <Brain size={14} className="text-blue-400" />
                        <span className="text-xs font-medium text-blue-300">{t('attach.embedRag')}</span>
                      </div>
                      <p className="text-xs text-gray-500 leading-relaxed">
                        {t('attach.embedRagDesc')}
                      </p>
                    </button>
                    <button
                      onClick={() => confirmMode('inline')}
                      className="flex flex-col items-start gap-1.5 p-3 bg-emerald-600/10 hover:bg-emerald-600/20 border border-emerald-600/30 hover:border-emerald-500/60 rounded-lg transition-colors text-left"
                    >
                      <div className="flex items-center gap-1.5">
                        <FileText size={14} className="text-emerald-400" />
                        <span className="text-xs font-medium text-emerald-300">{t('attach.extractedText')}</span>
                      </div>
                      <p className="text-xs text-gray-500 leading-relaxed">
                        {t('attach.extractedTextDesc')}
                      </p>
                    </button>
                  </>
                )}
                {/* Native attachment — available for all files */}
                <button
                  onClick={() => confirmMode('attachment')}
                  className="flex flex-col items-start gap-1.5 p-3 bg-violet-600/10 hover:bg-violet-600/20 border border-violet-600/30 hover:border-violet-500/60 rounded-lg transition-colors text-left"
                >
                  <div className="flex items-center gap-1.5">
                    <Paperclip size={14} className="text-violet-400" />
                    <span className="text-xs font-medium text-violet-300">
                      {CLAUDE_NATIVE_TYPES.includes(pendingFile.record.mimeType) ? t('attach.native') : t('attach.toMessage')}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 leading-relaxed">
                    {CLAUDE_NATIVE_TYPES.includes(pendingFile.record.mimeType)
                      ? t('attach.nativeDesc')
                      : t('attach.skillDesc')}
                  </p>
                </button>
              </div>

              {/* Note for formats without text extraction */}
              {!canExtractText(pendingFile.record.mimeType) && (
                <p className="mt-2 text-[10px] text-gray-600 leading-relaxed">
                  {t('attach.binaryNotePre')} <code className="text-gray-500">file_path</code>.
                </p>
              )}

              <button
                onClick={cancelPending}
                className="mt-2 text-xs text-gray-600 hover:text-gray-400 w-full text-center transition-colors"
              >
                {t('common:actions.cancel')}
              </button>
            </>
          ) : (
            /* ── Step 2: choose collection ── */
            <>
              <div className="flex items-center gap-2 mb-3">
                <Brain size={14} className="text-blue-400 flex-shrink-0" />
                <p className="text-xs text-gray-400 flex-1">
                  {t('collection.howToIndexPre')}{' '}
                  <span className="text-gray-200 font-medium">"{pendingFile.originalName}"</span>?
                </p>
              </div>

              {/* Scope: universal (company) | project | personal */}
              <select
                value={selectedScope}
                onChange={(e) => setSelectedScope(e.target.value as DocScope)}
                className="w-full mb-2 bg-gray-900 border border-gray-700 rounded-lg px-2.5 py-1.5
                  text-xs text-gray-200 focus:outline-none focus:border-blue-500 transition-colors"
              >
                <option value="universal">{t('scope.universal')}</option>
                <option value="project" disabled={!projectId}>{t('scope.project')}{projectId ? '' : t('scope.projectSuffix')}</option>
                <option value="personal">{t('scope.personal')}</option>
              </select>

              {collectionsLoading ? (
                <div className="flex items-center gap-1.5 text-xs text-gray-500 py-2">
                  <Loader2 size={11} className="animate-spin" /> {t('collection.loading')}
                </div>
              ) : (
                <select
                  value={selectedCollection}
                  onChange={(e) => setSelectedCollection(e.target.value)}
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-2.5 py-1.5
                    text-xs text-gray-200 focus:outline-none focus:border-blue-500 transition-colors"
                >
                  <option value="">{t('collection.default')}</option>
                  {collections.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              )}

              <p className="text-xs text-gray-600 mt-1.5 leading-tight">
                {t('collection.defaultNotePre')} <em>{t('collection.defaultNoteEm')}</em> {t('collection.defaultNotePost')}
              </p>

              <div className="flex gap-2 mt-3">
                <button
                  onClick={() => confirmMode('embed', selectedCollection, selectedScope)}
                  disabled={collectionsLoading}
                  className="flex-1 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50
                    text-white text-xs rounded-lg transition-colors flex items-center justify-center gap-1.5"
                >
                  <Brain size={11} /> {t('collection.index')}
                </button>
                <button
                  onClick={() => { setCollectionPickerOpen(false); setSelectedCollection(''); }}
                  className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200
                    border border-gray-700 rounded-lg transition-colors flex items-center gap-1"
                >
                  <ChevronLeft size={12} /> {t('common:actions.back')}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Attachments preview */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {attachments.map((att, i) => (
            <div
              key={att.fileId}
              className={`flex items-center gap-1.5 border rounded-lg px-2.5 py-1.5 text-xs ${
                att.mode === 'inline'
                  ? 'bg-emerald-900/30 border-emerald-700/40 text-emerald-300'
                  : att.mode === 'attachment'
                  ? 'bg-violet-900/30 border-violet-700/40 text-violet-300'
                  : 'bg-blue-900/30 border-blue-700/40 text-blue-300'
              }`}
            >
              {att.mode === 'inline' ? (
                <FileText size={11} className="text-emerald-400 flex-shrink-0" />
              ) : att.mode === 'attachment' ? (
                <Paperclip size={11} className="text-violet-400 flex-shrink-0" />
              ) : (
                <Brain size={11} className="text-blue-400 flex-shrink-0" />
              )}
              <span className="max-w-32 truncate">{att.name}</span>
              <span className="text-xs opacity-60">
                {att.mode === 'inline' ? t('attach.tagText') : att.mode === 'attachment' ? t('attach.tagNative') : t('attach.tagRag')}
              </span>
              <button
                onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                className="opacity-60 hover:opacity-100 ml-1 transition-opacity"
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2 bg-gray-800 border border-gray-700 rounded-2xl px-4 py-3 focus-within:border-blue-500 transition-colors">
        <button
          onClick={open}
          disabled={disabled || uploading || !!pendingFile}
          className="text-gray-500 hover:text-gray-300 flex-shrink-0 mb-0.5 transition-colors disabled:opacity-40"
          title={t('attach.attachFile')}
        >
          {uploading ? <Loader2 size={18} className="animate-spin" /> : <Paperclip size={18} />}
        </button>

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => { setText(e.target.value); adjustHeight(); }}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={
            recording ? t('voice.recording')
            : transcribing ? t('voice.transcribing')
            : disabled ? t('composer.processing')
            : t('composer.placeholder')
          }
          rows={1}
          className="flex-1 bg-transparent text-gray-100 placeholder-gray-500 resize-none focus:outline-none text-sm leading-relaxed"
          style={{ maxHeight: '200px' }}
        />

        {voiceEnabled && (
          <button
            onClick={toggleRecording}
            disabled={disabled || transcribing}
            className={`flex-shrink-0 mb-0.5 w-8 h-8 rounded-full flex items-center justify-center transition-colors disabled:opacity-40
              ${recording
                ? 'bg-red-600 hover:bg-red-500 text-white animate-pulse'
                : 'text-gray-500 hover:text-gray-300 hover:bg-gray-700/60'}`}
            title={recording ? t('voice.stop') : t('voice.start')}
          >
            {transcribing ? <Loader2 size={16} className="animate-spin" />
              : recording ? <Square size={14} />
              : <Mic size={16} />}
          </button>
        )}

        <button
          onClick={handleSend}
          disabled={disabled || !text.trim()}
          className="flex-shrink-0 mb-0.5 w-8 h-8 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-full flex items-center justify-center transition-colors"
        >
          <Send size={14} />
        </button>
      </div>

      <p className="text-xs text-gray-600 text-center mt-1.5">
        {t('disclaimer')}
      </p>
    </div>
  );
}
