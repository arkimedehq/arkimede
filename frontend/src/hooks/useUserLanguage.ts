/**
 * Syncs the interface language with the preference saved on the user profile
 * (User.language) and persists it when the user changes it.
 *
 * - When the profile arrives it applies `language` to i18next (takes precedence over auto-detect).
 * - `setLanguage` updates i18next + localStorage and saves to the backend.
 *
 * Must be mounted once in the authenticated shell (DashboardPage) to apply the
 * language to the whole app after login; the LanguageSwitcher reuses it for the select.
 */
import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import i18n, { applyUserLanguage, type AppLanguage } from '../i18n';
import { profileApi } from '../api/profile';

export function useUserLanguage() {
  const qc = useQueryClient();

  const profileQuery = useQuery({
    queryKey: ['profile'],
    queryFn: profileApi.get,
    staleTime: 60_000,
  });

  // Applies the profile preference when it arrives / changes.
  useEffect(() => {
    applyUserLanguage(profileQuery.data?.language);
  }, [profileQuery.data?.language]);

  const mutation = useMutation({
    mutationFn: (lang: AppLanguage) => profileApi.update({ language: lang }),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: ['profile'] });
      applyUserLanguage(updated.language);
    },
  });

  const setLanguage = (lang: AppLanguage) => {
    i18n.changeLanguage(lang); // immediate feedback; the save confirms it
    mutation.mutate(lang);
  };

  return {
    language: (i18n.resolvedLanguage as AppLanguage) ?? 'en',
    setLanguage,
    saving: mutation.isPending,
  };
}
