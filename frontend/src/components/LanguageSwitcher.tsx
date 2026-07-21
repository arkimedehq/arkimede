/**
 * Selettore lingua (it | en). Persiste su profilo via useUserLanguage.
 */
import { useTranslation } from 'react-i18next';
import { Languages } from 'lucide-react';
import { useUserLanguage } from '../hooks/useUserLanguage';
import { SUPPORTED_LANGUAGES, type AppLanguage } from '../i18n';

export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const { language, setLanguage, saving } = useUserLanguage();

  return (
    <label className="flex items-center gap-2 text-sm text-gray-300" title={t('language.hint')}>
      <Languages size={16} className="text-gray-400" />
      {!compact && <span>{t('language.label')}</span>}
      <select
        className="input-field"
        value={language}
        disabled={saving}
        onChange={(e) => setLanguage(e.target.value as AppLanguage)}
      >
        {SUPPORTED_LANGUAGES.map((lng) => (
          <option key={lng} value={lng}>{t(`language.${lng}`)}</option>
        ))}
      </select>
    </label>
  );
}
