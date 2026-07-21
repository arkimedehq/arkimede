import axios from 'axios';
import { useStore } from '../store/useStore';
import i18n from '../i18n';

/**
 * Base URL for REST calls.
 *
 * Priority:
 *   1. VITE_BACKEND_URL set → direct calls (e.g. "http://localhost:3000/api")
 *   2. VITE_API_URL set     → legacy compatibility
 *   3. Neither one          → relative "/api", handled by the Vite proxy in development
 *
 * ⚠️ If VITE_BACKEND_URL is set, calls bypass the Vite proxy
 *    and go directly to the backend: make sure CORS is configured.
 */
const backendUrl = (import.meta as any).env?.VITE_BACKEND_URL as string | undefined;
const BASE_URL = backendUrl
  ? `${backendUrl.replace(/\/$/, '')}/api`
  : ((import.meta as any).env?.VITE_API_URL as string | undefined) ?? '/api';

export const api = axios.create({ baseURL: BASE_URL });

api.interceptors.request.use((config) => {
  const token = useStore.getState().token;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  // Current language → the backend translates error messages (nestjs-i18n).
  config.headers['Accept-Language'] = i18n.resolvedLanguage ?? 'en';
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401) {
      useStore.getState().logout();
      window.location.href = '/login';
    }
    return Promise.reject(err);
  },
);

export default api;
