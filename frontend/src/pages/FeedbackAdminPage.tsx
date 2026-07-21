import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ThumbsUp, ThumbsDown, Trash2, Check, Loader2, AlertTriangle, Brain } from 'lucide-react';
import { feedbackApi } from '../api/feedback';
import type { Feedback } from '../api/feedback';

// ── Toggle memoria ────────────────────────────────────────────────────────────

function MemoryToggleCard() {
  const { t } = useTranslation('feedback');
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const { data: config } = useQuery({
    queryKey: ['feedback-config'],
    queryFn: () => feedbackApi.getConfig(),
  });

  const mutation = useMutation({
    mutationFn: (enabled: boolean) => feedbackApi.setEnabled(enabled),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['feedback-config'] });
    },
    onError: (err: any) => {
      setError(err?.response?.data?.message ?? t('memory.updateError'));
    },
  });

  const enabled = config?.enabled ?? false;
  const vectorAvailable = config?.vectorAvailable ?? false;

  return (
    <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <Brain size={20} className="text-indigo-400 mt-0.5 flex-shrink-0" />
          <div>
            <h3 className="text-sm font-semibold text-gray-100">{t('memory.title')}</h3>
            <p className="text-xs text-gray-400 mt-1 max-w-xl">
              {t('memory.descPre')} <code className="text-gray-300">feedback_memory</code> {t('memory.descPost')}
            </p>
          </div>
        </div>

        <button
          onClick={() => mutation.mutate(!enabled)}
          disabled={mutation.isPending}
          role="switch"
          aria-checked={enabled}
          className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors
            ${enabled ? 'bg-indigo-600' : 'bg-gray-600'} disabled:opacity-50`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform
            ${enabled ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
      </div>

      {!vectorAvailable && (
        <div className="mt-3 flex items-center gap-2 text-xs text-amber-400">
          <AlertTriangle size={13} />
          {t('memory.noVectorDB')}
        </div>
      )}
      {error && (
        <div className="mt-3 flex items-center gap-2 text-xs text-red-400">
          <AlertTriangle size={13} />
          {error}
        </div>
      )}
    </div>
  );
}

// ── Dashboard feedback ────────────────────────────────────────────────────────

function clip(s: string | null, n: number): string {
  if (!s) return '—';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function FeedbackRow({ fb }: { fb: Feedback }) {
  const { t } = useTranslation('feedback');
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['feedback-admin-list'] });

  const approve = useMutation({
    mutationFn: (approved: boolean) => feedbackApi.approve(fb.id, approved),
    onSuccess: invalidate,
  });
  const scope = useMutation({
    mutationFn: (s: 'personal' | 'shared') => feedbackApi.setScope(fb.id, s),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: () => feedbackApi.remove(fb.id),
    onSuccess: invalidate,
  });

  return (
    <tr className="border-t border-gray-800 align-top">
      <td className="py-2 px-2">
        {fb.rating === 'up'
          ? <ThumbsUp size={14} className="text-emerald-400" />
          : <ThumbsDown size={14} className="text-red-400" />}
      </td>
      <td className="py-2 px-2 text-gray-300 max-w-[200px]">{clip(fb.question, 120)}</td>
      <td className="py-2 px-2 text-gray-400 max-w-[260px]">{clip(fb.comment, 160)}</td>
      <td className="py-2 px-2">
        <button
          onClick={() => scope.mutate(fb.scope === 'shared' ? 'personal' : 'shared')}
          className={`text-[10px] px-1.5 py-0.5 rounded-full border transition-colors
            ${fb.scope === 'shared'
              ? 'border-blue-500/50 text-blue-300 bg-blue-500/10'
              : 'border-gray-600 text-gray-400 hover:text-gray-200'}`}
          title={t('dashboard.changeScope')}
        >
          {fb.scope}
        </button>
      </td>
      <td className="py-2 px-2">
        {fb.scope === 'shared' && (
          <button
            onClick={() => approve.mutate(!fb.isApproved)}
            className={`text-[10px] px-1.5 py-0.5 rounded-full border inline-flex items-center gap-1 transition-colors
              ${fb.isApproved
                ? 'border-emerald-500/50 text-emerald-300 bg-emerald-500/10'
                : 'border-amber-500/50 text-amber-300 hover:bg-amber-500/10'}`}
          >
            {fb.isApproved ? <><Check size={10} /> {t('dashboard.approved')}</> : t('dashboard.pending')}
          </button>
        )}
      </td>
      <td className="py-2 px-2 text-right">
        <button
          onClick={() => remove.mutate()}
          className="text-gray-600 hover:text-red-400 transition-colors"
          title={t('common:actions.delete')}
        >
          <Trash2 size={14} />
        </button>
      </td>
    </tr>
  );
}

function FeedbackDashboard() {
  const { t } = useTranslation('feedback');
  const { data: feedback = [], isLoading } = useQuery({
    queryKey: ['feedback-admin-list'],
    queryFn: () => feedbackApi.list(),
  });

  return (
    <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-5">
      <h3 className="text-sm font-semibold text-gray-100 mb-3">{t('dashboard.title')}</h3>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <Loader2 size={14} className="animate-spin" /> {t('common:actions.loading')}
        </div>
      ) : feedback.length === 0 ? (
        <p className="text-sm text-gray-500">{t('dashboard.empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-gray-500">
                <th className="py-1 px-2 font-medium">{t('dashboard.table.rating')}</th>
                <th className="py-1 px-2 font-medium">{t('dashboard.table.question')}</th>
                <th className="py-1 px-2 font-medium">{t('dashboard.table.correction')}</th>
                <th className="py-1 px-2 font-medium">{t('dashboard.table.scope')}</th>
                <th className="py-1 px-2 font-medium">{t('dashboard.table.status')}</th>
                <th className="py-1 px-2"></th>
              </tr>
            </thead>
            <tbody>
              {feedback.map((fb) => <FeedbackRow key={fb.id} fb={fb} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function FeedbackSection() {
  const { t } = useTranslation('feedback');
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-white">{t('section.title')}</h2>
        <p className="text-sm text-gray-500 mt-1">
          {t('section.subtitle')}
        </p>
      </div>
      <MemoryToggleCard />
      <FeedbackDashboard />
    </div>
  );
}
