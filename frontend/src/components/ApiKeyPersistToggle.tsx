// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiKeysApi, type ApiKeyRow } from '../api/apiKeys';

/**
 * Per-key "save conversations" checkbox, shared by the own-keys card (Settings)
 * and the admin key editor (Users). `queryKey` is the list to refresh.
 */
export default function ApiKeyPersistToggle({ row, queryKey }: { row: ApiKeyRow; queryKey: unknown[] }) {
  const { t } = useTranslation('settings');
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (value: boolean) => apiKeysApi.setPersistConversations(row.id, value),
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  });

  return (
    <label className="flex items-center gap-1.5 text-[11px] text-gray-400 cursor-pointer w-fit" title={t('apiKeys.persistHint')}>
      <input
        type="checkbox"
        checked={row.persistConversations}
        disabled={mutation.isPending}
        onChange={(e) => mutation.mutate(e.target.checked)}
        className="accent-blue-500"
      />
      {t('apiKeys.persistLabel')}
    </label>
  );
}
