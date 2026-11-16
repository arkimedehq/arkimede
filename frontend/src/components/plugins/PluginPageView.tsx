// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * A plugin's page (specs/PLUGINS.md §7.2): the plugin's own HTML in an isolated iframe — `sandbox` without
 * `allow-same-origin`, so the page has an opaque origin and never sees Arkimede's storage, cookies or token; its CSP
 * forbids any network call. Its only way out is this bridge: a `request` becomes a call to one of the plugin's routes,
 * made here with the user's credentials; `context` gives the user's name, theme and language. Only messages from the
 * iframe this view created are answered.
 */
import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import i18n from '../../i18n';
import { useStore } from '../../store/useStore';
import { apiUrl, pluginsApi } from '../../api/plugins';

const MAX_BODY_CHARS = 1_000_000;

export default function PluginPageView({ name, page, title }: { name: string; page: string; title: string }) {
  const { t } = useTranslation('settings');
  const frame = useRef<HTMLIFrameElement>(null);
  const userName = useStore((s) => s.user?.name ?? '');
  const { data, isLoading, error } = useQuery({
    queryKey: ['plugin-page-url', name, page],
    queryFn: () => pluginsApi.pageUrl(name, page),
    staleTime: 50 * 60_000,
  });

  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      const win = frame.current?.contentWindow;
      if (!win || e.source !== win) return;
      const m = e.data;
      if (!m || typeof m !== 'object' || m.arkimede !== 1 || (typeof m.id !== 'number' && typeof m.id !== 'string')) return;
      const reply = (r: Record<string, unknown>) => win.postMessage({ arkimede: 1, id: m.id, ...r }, '*');
      if (m.type === 'context') {
        reply({ ok: true, body: { user: { name: userName }, theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light', lang: i18n.resolvedLanguage ?? 'en' } });
        return;
      }
      if (m.type !== 'request') {
        reply({ ok: false, status: 400, body: { error: 'Unknown message type' } });
        return;
      }
      const body: unknown = m.body;
      try {
        if (body !== undefined && JSON.stringify(body).length > MAX_BODY_CHARS) throw new Error('too large');
      } catch {
        reply({ ok: false, status: 413, body: { error: 'Body too large or not JSON' } });
        return;
      }
      const query = m.query && typeof m.query === 'object' ? Object.fromEntries(Object.entries(m.query).map(([k, v]) => [k, String(v)])) : undefined;
      try {
        const r = await pluginsApi.route(name, String(m.method ?? 'GET'), m.path, body, query);
        reply({ ok: r.status < 400, status: r.status, body: r.body });
      } catch {
        reply({ ok: false, status: 502, body: { error: 'Request failed' } });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [name, userName]);

  if (isLoading) {
    return <div className="flex-1 flex items-center justify-center text-gray-500"><Loader2 className="animate-spin" size={20} /></div>;
  }
  if (error || !data) {
    return <div className="flex-1 flex items-center justify-center text-sm text-gray-500">{t('plugins.pageUnavailable')}</div>;
  }
  return (
    <iframe
      ref={frame}
      key={`${name}/${page}`}
      title={title}
      src={apiUrl(data.url)}
      sandbox="allow-scripts allow-forms"
      referrerPolicy="no-referrer"
      className="flex-1 w-full min-h-0 border-0 bg-white"
    />
  );
}
