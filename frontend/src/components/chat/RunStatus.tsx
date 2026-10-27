// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Loader2, Square, X } from 'lucide-react';
import type { ChatRunState } from '../../api/chatRuns';
import { APP_NAME } from '../../config/app.config';

interface Props {
  run: ChatRunState;
  /** The finished tools of the run (shown when this page did not send the message). */
  showRecent?: boolean;
  /** Stop button (shown when this page did not send the message: the header has its own). */
  onStop?: () => void;
  stopping?: boolean;
}

function useSecondsSince(iso: string): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
}

/** What the agent is doing now: the step, the tool, how long the current phase has lasted. */
export default function RunStatus({ run, showRecent, onStop, stopping }: Props) {
  const { t, i18n } = useTranslation('chat');
  const seconds = useSecondsSince(run.phaseSince);
  const tool = run.tool ?? '';

  const detail = [
    t(`run.phase.${run.phase}`, { tool }),
    run.phase === 'preparing' && run.argsChars > 0
      ? t('run.chars', { chars: run.argsChars.toLocaleString(i18n.language) })
      : null,
    seconds >= 3 ? t('run.seconds', { seconds }) : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="flex justify-start">
      <div className="bg-gray-800 rounded-xl px-4 py-2.5 text-sm text-gray-300 max-w-xl space-y-1">
        <div className="flex items-center gap-2">
          <Loader2 size={13} className="text-yellow-400 animate-spin flex-shrink-0" />
          <span>
            {t('run.working', { app: APP_NAME })}
            {tool && <>: <strong>{tool}</strong></>}
            {run.step > 0 && <span className="text-gray-500"> ({t('run.step', { step: run.step })})</span>}
          </span>
          {onStop && (
            <button
              onClick={onStop}
              disabled={stopping}
              className="ml-auto inline-flex items-center gap-1 text-xs text-gray-400 hover:text-red-400 disabled:opacity-50"
              title={t('run.stop')}
            >
              <Square size={11} /> {stopping ? t('run.stopping') : t('run.stop')}
            </button>
          )}
        </div>
        <div className="text-xs text-gray-500 pl-5">{detail}</div>
        {showRecent && run.recent.length > 0 && (
          <div className="pl-5 pt-1 space-y-0.5 text-xs text-gray-400">
            {run.recent.map((r, i) => (
              <div key={i} className="flex items-center gap-1.5">
                {r.ok
                  ? <Check size={11} className="text-emerald-400 flex-shrink-0" />
                  : <X size={11} className="text-red-400 flex-shrink-0" />}
                <span>{r.tool}</span>
                {r.durationMs != null && <span className="text-gray-600 font-mono">{r.durationMs}ms</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
