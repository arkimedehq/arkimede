// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Repeat, Square } from 'lucide-react';
import type { SequenceState } from '../../api/chatRuns';

interface Props {
  sequence: SequenceState;
  onStop: () => void;
  stopping?: boolean;
}

/** A sequence running from this chat: its title, the actions done, the time against the planned time, a stop button. */
export default function SequenceStatus({ sequence, onStop, stopping }: Props) {
  const { t } = useTranslation('chat');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const seconds = Math.max(0, Math.floor((now - Date.parse(sequence.startedAt)) / 1000));
  const planned = Math.round(sequence.plannedSeconds);
  const { calls, failures } = sequence.progress;

  return (
    <div className="flex justify-start">
      <div className="bg-gray-800 rounded-xl px-4 py-2.5 text-sm text-gray-300 max-w-xl space-y-1">
        <div className="flex items-center gap-2">
          <Repeat size={13} className="text-sky-400 animate-pulse flex-shrink-0" />
          <span>
            {t('sequence.running')}: <strong>{sequence.title}</strong>
          </span>
          <button
            onClick={onStop}
            disabled={stopping}
            className="ml-auto inline-flex items-center gap-1 text-xs text-gray-400 hover:text-red-400 disabled:opacity-50"
            title={t('run.stop')}
          >
            <Square size={11} /> {stopping ? t('run.stopping') : t('run.stop')}
          </button>
        </div>
        <div className="text-xs text-gray-500 pl-5">
          {[
            t('sequence.calls', { count: calls }),
            failures ? t('sequence.failures', { count: failures }) : null,
            planned > 0 ? t('sequence.time', { seconds: Math.min(seconds, planned), planned }) : t('run.seconds', { seconds }),
          ].filter(Boolean).join(' · ')}
        </div>
      </div>
    </div>
  );
}
