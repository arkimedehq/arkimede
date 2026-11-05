// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Admin cards in Settings → Memory for Recordare (the external episodic memory):
 *   - the connection: URL, client API key, a connection test, where each value comes from (these settings or the
 *     server's environment);
 *   - the initiatives webhook (its own card: Recordare pushes what the memory decides to say on its own): the address
 *     to register in Recordare's console, the whsec_ secret it gives back, the last delivery received.
 * Saved values apply at once (no restart). Shown to admins, also when Recordare is not configured yet.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle, Copy, Check, Eye, EyeOff, Loader2, Plug, Save, Webhook, XCircle } from 'lucide-react';
import { recordareConfigApi, type RecordareSource, type UpdateRecordareConfigPayload } from '../../api/appConfig';
import { copyText } from '../../utils/clipboard';

const input = `w-full px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-100 placeholder-gray-600
  focus:outline-none focus:border-blue-500 transition-colors`;
const card = 'bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4';
const button = `inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border border-gray-700 text-gray-300
  hover:border-gray-500 disabled:opacity-50 transition-colors`;

function SourceBadge({ source }: { source: RecordareSource }) {
  const { t } = useTranslation('settings');
  const cls = source === 'settings' ? 'text-blue-300 border-blue-500/40' : source === 'env' ? 'text-amber-300 border-amber-500/40' : 'text-gray-500 border-gray-700';
  return <span className={`text-[10px] px-1.5 py-0.5 rounded border ${cls}`}>{t(`memory.recordare.source.${source ?? 'none'}`)}</span>;
}

function Field({ label, help, source, children }: { label: string; help: string; source?: RecordareSource; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <label className="text-xs font-medium text-gray-400">{label}</label>
        {source !== undefined && <SourceBadge source={source} />}
      </div>
      {children}
      <p className="text-xs text-gray-500 mt-1">{help}</p>
    </div>
  );
}

/** A secret field: empty keeps the stored value; "remove" clears it (the environment applies again). */
function SecretInput({ value, onChange, stored, placeholder, onClear }: {
  value: string; onChange: (v: string) => void; stored: boolean; placeholder: string; onClear: () => void;
}) {
  const { t } = useTranslation('settings');
  const [show, setShow] = useState(false);
  return (
    <div className="flex gap-2">
      <div className="relative flex-1">
        <input type={show ? 'text' : 'password'} autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)}
          placeholder={stored ? t('memory.recordare.secretStored') : placeholder} className={`${input} pr-9`} />
        <button type="button" onClick={() => setShow(!show)} className="absolute right-2 top-1.5 text-gray-500 hover:text-gray-300"
          aria-label={show ? t('memory.recordare.hide') : t('memory.recordare.show')}>
          {show ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
      {stored && <button type="button" onClick={onClear} className={button}>{t('memory.recordare.remove')}</button>}
    </div>
  );
}

function useRecordareConfig() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['recordare-config'], queryFn: recordareConfigApi.get });
  const save = useMutation({
    mutationFn: (p: UpdateRecordareConfigPayload) => recordareConfigApi.update(p),
    onSuccess: (data) => {
      qc.setQueryData(['recordare-config'], data);
      void qc.invalidateQueries({ queryKey: ['profile'] }); // episodicMemoryAvailable may have changed
    },
  });
  return { query, save };
}

const errorText = (e: unknown) => (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? (e as Error)?.message;

export function RecordareConnectionCard() {
  const { t } = useTranslation('settings');
  const { query, save } = useRecordareConfig();
  const cfg = query.data;
  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [result, setResult] = useState<{ ok: boolean; error?: string; latencyMs?: number } | null>(null);
  useEffect(() => { setUrl(cfg?.recordareUrl ?? ''); }, [cfg?.recordareUrl]);
  const test = useMutation({ mutationFn: recordareConfigApi.test, onMutate: () => setResult(null), onSuccess: setResult,
    onError: (e) => setResult({ ok: false, error: errorText(e) }) });

  const submit = async () => {
    const payload: UpdateRecordareConfigPayload = { recordareUrl: url.trim() || null };
    if (apiKey.trim()) payload.recordareApiKey = apiKey.trim();
    await save.mutateAsync(payload);
    setApiKey('');
    test.mutate();
  };

  return (
    <div className={card}>
      <div>
        <h3 className="text-sm font-semibold text-gray-100 flex items-center gap-2">
          <Plug size={14} className="text-gray-400" />
          {t('memory.recordare.title')}
          {cfg && (cfg.configured
            ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-600/20 text-green-300">{t('memory.recordare.configured')}</span>
            : <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-400">{t('memory.recordare.notConfigured')}</span>)}
        </h3>
        <p className="text-sm text-gray-500 mt-1">{t('memory.recordare.intro')}</p>
      </div>
      {query.isLoading ? <Loader2 size={16} className="animate-spin text-gray-500" /> : (
        <>
          <Field label={t('memory.recordare.url')} help={t('memory.recordare.urlHelp')} source={cfg?.sources.url}>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={cfg?.effectiveUrl ?? 'http://recordare:8080'} className={input} />
          </Field>
          <Field label={t('memory.recordare.apiKey')} help={t('memory.recordare.apiKeyHelp')} source={cfg?.sources.apiKey}>
            <SecretInput value={apiKey} onChange={setApiKey} stored={!!cfg?.hasRecordareApiKey} placeholder="rk_…"
              onClear={() => save.mutate({ recordareApiKey: null })} />
          </Field>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button onClick={() => void submit().catch(() => undefined)} disabled={save.isPending}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50">
              {save.isPending ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}{t('memory.recordare.save')}
            </button>
            <button onClick={() => test.mutate()} disabled={test.isPending || !cfg?.configured} className={button}>
              {test.isPending ? <Loader2 size={12} className="animate-spin" /> : <Plug size={12} />}{t('memory.recordare.test')}
            </button>
            {result && (result.ok
              ? <span className="text-xs text-green-400 flex items-center gap-1"><CheckCircle size={12} />{t('memory.recordare.testOk', { ms: result.latencyMs })}</span>
              : <span className="text-xs text-red-400 flex items-center gap-1"><XCircle size={12} />{t('memory.recordare.testFail', { error: result.error })}</span>)}
            {save.isError && <span className="text-xs text-red-400">{t(`memory.recordare.errors.${errorText(save.error)}`, { defaultValue: errorText(save.error) })}</span>}
          </div>
          <p className="text-xs text-gray-600">{t('memory.recordare.sourceLegend')}</p>
        </>
      )}
    </div>
  );
}

export function RecordareInitiativesCard() {
  const { t } = useTranslation('settings');
  const { query, save } = useRecordareConfig();
  const cfg = query.data;
  const [secret, setSecret] = useState('');
  const [copied, setCopied] = useState(false);
  const address = `${window.location.origin}/api/recordare/webhook`;
  const ready = !!cfg?.configured && !!cfg?.sources.webhookSecret;

  return (
    <div className={card}>
      <div>
        <h3 className="text-sm font-semibold text-gray-100 flex items-center gap-2">
          <Webhook size={14} className="text-gray-400" />
          {t('memory.recordare.initiativesTitle')}
          {cfg && (ready
            ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-600/20 text-green-300">{t('memory.recordare.webhookOn')}</span>
            : <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-400">{t('memory.recordare.webhookOff')}</span>)}
        </h3>
        <p className="text-sm text-gray-500 mt-1">{t('memory.recordare.initiativesIntro')}</p>
      </div>
      <ol className="text-xs text-gray-400 list-decimal pl-4 space-y-1">
        <li>{t('memory.recordare.step1')}</li>
        <li>{t('memory.recordare.step2')}</li>
        <li>{t('memory.recordare.step3')}</li>
      </ol>
      <Field label={t('memory.recordare.webhookUrl')} help={t('memory.recordare.webhookUrlHelp')}>
        <div className="flex gap-2">
          <input readOnly value={address} className={`${input} font-mono text-xs`} onFocus={(e) => e.target.select()} />
          <button type="button" className={button}
            onClick={() => void copyText(address).then((ok) => { setCopied(ok); setTimeout(() => setCopied(false), 1500); })}>
            {copied ? <Check size={12} /> : <Copy size={12} />}{t('memory.recordare.copy')}
          </button>
        </div>
      </Field>
      <Field label={t('memory.recordare.events')} help={t('memory.recordare.eventsHelp')}>
        <code className="text-xs text-gray-300 bg-gray-800 px-2 py-1 rounded">initiative.deliver</code>
      </Field>
      <Field label={t('memory.recordare.webhookSecret')} help={t('memory.recordare.webhookSecretHelp')} source={cfg?.sources.webhookSecret}>
        <SecretInput value={secret} onChange={setSecret} stored={!!cfg?.hasRecordareWebhookSecret} placeholder="whsec_…"
          onClear={() => save.mutate({ recordareWebhookSecret: null })} />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <button disabled={save.isPending || !secret.trim()}
          onClick={() => save.mutate({ recordareWebhookSecret: secret.trim() }, { onSuccess: () => setSecret('') })}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50">
          {save.isPending ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}{t('memory.recordare.save')}
        </button>
        {save.isError && <span className="text-xs text-red-400">{t(`memory.recordare.errors.${errorText(save.error)}`, { defaultValue: errorText(save.error) })}</span>}
      </div>
      <div className="pt-2 border-t border-gray-800 text-xs">
        <span className="text-gray-400">{t('memory.recordare.lastWebhook')}: </span>
        {cfg?.lastWebhook
          ? <span className="text-gray-200">{new Date(cfg.lastWebhook.at).toLocaleString()} · <code>{cfg.lastWebhook.type}</code></span>
          : <span className="text-gray-500">{t('memory.recordare.lastWebhookNone')}</span>}
        <p className="text-gray-600 mt-1">{t('memory.recordare.lastWebhookHelp')}</p>
      </div>
    </div>
  );
}
