import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { authApi } from '../api/auth';
import { useStore } from '../store/useStore';
import { APP_NAME } from '../config/app.config';

export default function RegisterPage() {
  const { t } = useTranslation('auth');
  const navigate = useNavigate();
  const setAuth = useStore((s) => s.setAuth);
  const [form, setForm] = useState({ email: '', name: '', password: '', confirm: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.password !== form.confirm) { setError(t('register.passwordMismatch')); return; }
    setError('');
    setLoading(true);
    try {
      const data = await authApi.register(form.email, form.name, form.password);
      setAuth(data.access_token, data.user);
      navigate('/');
    } catch (err: any) {
      setError(err.response?.data?.message || t('register.error'));
    } finally {
      setLoading(false);
    }
  };

  const f = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((prev) => ({ ...prev, [k]: e.target.value }));

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 bg-blue-600 rounded-xl mb-4">
            <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-white">{APP_NAME}</h1>
          <p className="text-gray-400 mt-1">{t('register.subtitle')}</p>
        </div>

        <form onSubmit={handleSubmit} className="bg-gray-900 rounded-2xl p-6 shadow-xl border border-gray-800 space-y-4">
          {error && (
            <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-lg p-3 text-sm">
              {error}
            </div>
          )}

          {[
            { label: t('register.nameLabel'), key: 'name', type: 'text', placeholder: t('register.namePlaceholder') },
            { label: t('register.emailLabel'), key: 'email', type: 'email', placeholder: t('register.emailPlaceholder') },
            { label: t('register.passwordLabel'), key: 'password', type: 'password', placeholder: '••••••••' },
            { label: t('register.confirmLabel'), key: 'confirm', type: 'password', placeholder: '••••••••' },
          ].map(({ label, key, type, placeholder }) => (
            <div key={key}>
              <label className="block text-sm font-medium text-gray-300 mb-1.5">{label}</label>
              <input
                type={type}
                value={form[key as keyof typeof form]}
                onChange={f(key)}
                className="input-field"
                placeholder={placeholder}
                required
              />
            </div>
          ))}

          <button type="submit" disabled={loading} className="btn-primary w-full mt-2">
            {loading ? t('register.submitting') : t('register.submit')}
          </button>
        </form>

        <p className="text-center text-gray-500 mt-4 text-sm">
          {t('register.haveAccount')}{' '}
          <Link to="/login" className="text-blue-400 hover:text-blue-300">
            {t('register.login')}
          </Link>
        </p>
      </div>
    </div>
  );
}
