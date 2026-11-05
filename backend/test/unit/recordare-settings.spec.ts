// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Recordare from the admin's settings: stored values (secrets encrypted) win over the environment field by field and
 * apply at once (listeners told, no restart); clearing a value brings the environment back; the webhook uses the
 * stored secret and records the last delivery; the view never returns a secret.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'crypto';
import { AppConfigService } from '../../src/app-config/app-config.service';
import {
  lastRecordareWebhook, onRecordareSettingsChange, recordareConfig, recordareSources, recordareWebhookSecret, setRecordareSettings,
} from '../../src/recordare/recordare.config';
import { RecordareWebhookController } from '../../src/recordare/recordare-webhook.controller';

const ENV = ['RECORDARE_URL', 'RECORDARE_API_KEY', 'RECORDARE_WEBHOOK_SECRET'] as const;
const SECRET = `whsec_${Buffer.from('a stored webhook secret, long enough').toString('base64')}`;

function fakeRepo() {
  let row: Record<string, unknown> | null = { id: 1, systemPrompt: 'p' };
  return {
    row: () => row,
    findOne: async () => row,
    save: async (x: Record<string, unknown>) => { row = { ...row, ...x }; return row; },
  };
}

describe('Recordare settings', () => {
  beforeAll(() => { process.env.TOOL_SECRETS_KEY = 'a'.repeat(64); });
  afterEach(() => {
    for (const k of ENV) delete process.env[k];
    setRecordareSettings({ url: null, apiKey: null, webhookSecret: null });
  });

  it('stored values win field by field; an empty one falls back to the environment', () => {
    process.env.RECORDARE_URL = 'http://env:8080';
    process.env.RECORDARE_API_KEY = 'rk_env';
    expect(recordareConfig()).toEqual({ url: 'http://env:8080', apiKey: 'rk_env' });
    setRecordareSettings({ url: 'http://stored:9000/', apiKey: null, webhookSecret: null });
    expect(recordareConfig()).toEqual({ url: 'http://stored:9000', apiKey: 'rk_env' });
    expect(recordareSources()).toEqual({ url: 'settings', apiKey: 'env', webhookSecret: null });
    delete process.env.RECORDARE_API_KEY;
    expect(recordareConfig()).toBeNull();
  });

  it('saving encrypts the secrets, applies at once and tells the listeners; the view masks them; null clears', async () => {
    const repo = fakeRepo();
    const svc = new AppConfigService(repo as any, {} as any);
    let told = 0;
    const stop = onRecordareSettingsChange(() => { told++; });
    const view = await svc.updateRecordareConfig({ recordareUrl: 'http://recordare:8080/', recordareApiKey: 'rk_live', recordareWebhookSecret: SECRET });
    stop();
    expect(told).toBe(1);
    expect(repo.row()).toMatchObject({ recordareUrl: 'http://recordare:8080' });
    expect(String(repo.row()!.recordareApiKey)).not.toContain('rk_live');
    expect(recordareConfig()).toEqual({ url: 'http://recordare:8080', apiKey: 'rk_live' });
    expect(recordareWebhookSecret()).toBe(SECRET);
    expect(view).toMatchObject({ configured: true, hasRecordareApiKey: true, hasRecordareWebhookSecret: true, effectiveUrl: 'http://recordare:8080' });
    expect(JSON.stringify(view)).not.toContain('rk_live');
    // Undefined keeps; null clears (the environment applies again).
    await svc.updateRecordareConfig({ recordareUrl: 'http://other:8080' });
    expect(recordareConfig()?.apiKey).toBe('rk_live');
    await svc.updateRecordareConfig({ recordareApiKey: null });
    expect(recordareConfig()).toBeNull();
    // At start-up the stored row is handed over.
    setRecordareSettings({ url: null, apiKey: null, webhookSecret: null });
    await svc.updateRecordareConfig({ recordareApiKey: 'rk_again' });
    setRecordareSettings({ url: null, apiKey: null, webhookSecret: null });
    await svc.onModuleInit();
    expect(recordareConfig()).toEqual({ url: 'http://other:8080', apiKey: 'rk_again' });
  });

  it('the webhook verifies with the stored secret and records the last delivery', () => {
    setRecordareSettings({ url: 'http://recordare:8080', apiKey: 'rk', webhookSecret: SECRET });
    const ctl = new RecordareWebhookController({ handleEvent: async () => undefined } as any);
    const body = JSON.stringify({ type: 'initiative.updated', timestamp: '', data: {} });
    const ts = Math.floor(Date.now() / 1000);
    const sig = `v1,${createHmac('sha256', Buffer.from(SECRET.replace(/^whsec_/, ''), 'base64')).update(`m1.${ts}.${body}`).digest('base64')}`;
    ctl.receive({ rawBody: Buffer.from(body) } as any, { 'webhook-id': 'm1', 'webhook-timestamp': String(ts), 'webhook-signature': sig });
    expect(lastRecordareWebhook()).toMatchObject({ type: 'initiative.updated' });
  });
});
