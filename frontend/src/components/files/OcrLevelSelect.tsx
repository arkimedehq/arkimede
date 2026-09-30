// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ocrApi, OCR_LEVELS, type OcrLevel } from '../../api/ocr';

interface Props {
  /** '' = the admin default (not sent to the backend). */
  value:     OcrLevel | '';
  onChange:  (level: OcrLevel | '') => void;
  className?: string;
}

/**
 * OCR level picker for indexing a PDF/image. Levels above the admin maximum are
 * hidden; levels not available on this deployment are shown disabled with the
 * reason. The hint under the select describes the chosen (or default) level.
 */
export default function OcrLevelSelect({ value, onChange, className }: Props) {
  const { t } = useTranslation('files');
  const { data } = useQuery({ queryKey: ['ocr-levels'], queryFn: ocrApi.levels, staleTime: 30_000 });
  if (!data) return null;

  const maxRank = OCR_LEVELS.indexOf(data.maxLevel);
  const offered = data.levels.filter((l) => OCR_LEVELS.indexOf(l.level) <= maxRank);
  const shown = value || data.defaultLevel;

  return (
    <div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as OcrLevel | '')}
        className={className}
        title={t('ocr.label')}
      >
        <option value="">{t('ocr.defaultOption', { level: t(`ocr.levels.${data.defaultLevel}`) })}</option>
        {offered.map((l) => (
          <option key={l.level} value={l.level} disabled={!l.available}>
            {t(`ocr.levels.${l.level}`)}{l.available ? '' : ` — ${t(`ocr.reasons.${l.reason}`)}`}
          </option>
        ))}
      </select>
      <p className="text-xs text-gray-600 mt-1 leading-tight">{t(`ocr.hints.${shown}`)}</p>
    </div>
  );
}
