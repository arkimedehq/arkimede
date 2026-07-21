import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { projectsApi } from '../../api/projects';
import { useStore } from '../../store/useStore';
import ProjectTeamsSection from './ProjectTeamsSection';
import { X, Bot, Trash2 } from 'lucide-react';

const COLORS = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#06b6d4', '#84cc16'];

interface Props {
  project?: any;
  onClose: () => void;
  onSaved: () => void;
}

export default function ProjectModal({ project, onClose, onSaved }: Props) {
  const { t } = useTranslation(['projects', 'common']);
  const [name, setName]               = useState(project?.name || '');
  const [description, setDescription] = useState(project?.description || '');
  const [color, setColor]             = useState(project?.color || COLORS[0]);
  const [systemPrompt, setSystemPrompt] = useState<string>(project?.systemPrompt || '');
  const [error, setError]             = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const user = useStore((s) => s.user);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const setActiveProject = useStore((s) => s.setActiveProject);
  // Management (sharing + deletion) reserved for the project owner or an
  // admin, and only for already-created projects (the id is required).
  const canManageSharing = !!project?.id && (user?.role === 'admin' || project?.userId === user?.id);

  const save = useMutation({
    mutationFn: () =>
      project
        ? projectsApi.update(project.id, {
            name,
            description,
            color,
            systemPrompt: systemPrompt.trim() || null,
          })
        : projectsApi.create({
            name,
            description,
            color,
            systemPrompt: systemPrompt.trim() || null,
          }),
    onSuccess: onSaved,
    onError: (err: any) => setError(err.response?.data?.message || t('modal.error')),
  });

  const del = useMutation({
    mutationFn: () => projectsApi.delete(project!.id),
    onSuccess: () => {
      // If I was working in this project, exit the project context.
      if (activeProjectId === project!.id) setActiveProject(null);
      onSaved();
    },
    onError: (err: any) => setError(err.response?.data?.message || t('modal.error')),
  });

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <h2 className="font-semibold text-white">{project ? t('modal.editTitle') : t('modal.newTitle')}</h2>
          <button onClick={onClose} className="btn-ghost p-1.5"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4">
          {error && <div className="text-red-400 text-sm bg-red-500/10 rounded-lg p-2">{error}</div>}

          <div>
            <label className="block text-sm text-gray-300 mb-1.5">{t('modal.nameLabel')}</label>
            <input
              className="input-field"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('modal.namePlaceholder')}
              required
            />
          </div>

          <div>
            <label className="block text-sm text-gray-300 mb-1.5">{t('modal.descLabel')}</label>
            <textarea
              className="input-field resize-none"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('modal.descPlaceholder')}
            />
          </div>

          <div>
            <label className="block text-sm text-gray-300 mb-2">{t('modal.colorLabel')}</label>
            <div className="flex gap-2 flex-wrap">
              {COLORS.map((c) => (
                <button
                  key={c}
                  className={`w-7 h-7 rounded-full transition-transform ${color === c ? 'scale-125 ring-2 ring-white ring-offset-2 ring-offset-gray-900' : 'hover:scale-110'}`}
                  style={{ backgroundColor: c }}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
          </div>

          {/* Custom AI instructions */}
          <div>
            <label className="block text-sm text-gray-300 mb-1.5 flex items-center gap-1.5">
              <Bot size={13} className="text-gray-400" />
              {t('modal.aiLabel')}
            </label>
            <textarea
              className="input-field resize-none font-mono text-xs leading-relaxed"
              rows={4}
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder={t('modal.aiPlaceholder')}
            />
            <p className="text-xs text-gray-600 mt-1">
              {t('modal.aiHint')}
            </p>
          </div>

          {canManageSharing && <ProjectTeamsSection projectId={project.id} />}
        </div>

        {/* Project deletion (owner/admin). Chats and files are NOT
            deleted: they leave the project (projectId → null). */}
        {canManageSharing && (
          <div className="px-5 pb-1">
            {confirmDelete ? (
              <div className="flex items-center gap-2 bg-red-500/10 border border-red-900/40 rounded-lg p-2.5">
                <span className="text-xs text-red-300 flex-1">
                  {t('modal.deleteConfirm')}
                </span>
                <button
                  onClick={() => del.mutate()}
                  disabled={del.isPending}
                  className="px-2.5 py-1 text-xs bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white rounded-lg transition-colors"
                >
                  {del.isPending ? t('modal.deleting') : t('common:actions.confirm')}
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  disabled={del.isPending}
                  className="px-2.5 py-1 text-xs text-gray-400 hover:text-gray-200 rounded-lg transition-colors"
                >
                  {t('common:actions.cancel')}
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                className="inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-red-400 transition-colors"
              >
                <Trash2 size={13} /> {t('modal.deleteCta')}
              </button>
            )}
          </div>
        )}

        <div className="flex gap-3 p-5 border-t border-gray-800">
          <button onClick={onClose} className="btn-ghost flex-1">{t('common:actions.cancel')}</button>
          <button
            onClick={() => save.mutate()}
            disabled={!name.trim() || save.isPending}
            className="btn-primary flex-1"
          >
            {save.isPending ? t('modal.saving') : project ? t('common:actions.save') : t('modal.createCta')}
          </button>
        </div>
      </div>
    </div>
  );
}
