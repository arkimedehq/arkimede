/**
 * H3 regression — safeFetch (common/ssrf-guard.ts) must re-apply the anti-SSRF
 * guard to EVERY redirect hop, not just the initial URL. The default fetch follows
 * redirects transparently, so a public URL that 302s to 169.254.169.254 / loopback
 * would reach the internal target after a one-shot check.
 *
 * We use literal PUBLIC IPs as endpoints (assertPublicUrl classifies literal IPs
 * without DNS), and stub global fetch to script the redirects.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { safeFetch } from '../../src/common/ssrf-guard';

type Call = { url: string; method?: string; body: unknown; auth: string | null };

/** Install a scripted fetch; returns the captured per-hop calls (header state snapshotted). */
function scriptFetch(script: (url: string, hop: number) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    calls.push({
      url,
      method: init?.method,
      body: init?.body,
      auth: new Headers(init?.headers).get('authorization'), // snapshot (headers is mutated across hops)
    });
    return script(url, calls.length - 1);
  }));
  return calls;
}

const redirect = (location: string, status = 302) =>
  new Response(null, { status, headers: { location } });

afterEach(() => vi.unstubAllGlobals());

describe('safeFetch — redirects are re-validated (H3)', () => {
  it('blocks a redirect from a public URL to the metadata endpoint', async () => {
    scriptFetch((_url, hop) => hop === 0
      ? redirect('http://169.254.169.254/latest/meta-data/')
      : new Response('should-not-reach'));
    await expect(safeFetch('http://1.1.1.1/')).rejects.toThrow(/Internal destination not allowed/);
  });

  it('blocks a redirect to loopback', async () => {
    scriptFetch((_url, hop) => hop === 0 ? redirect('http://127.0.0.1:6379/') : new Response('x'));
    await expect(safeFetch('http://8.8.8.8/')).rejects.toThrow();
  });

  it('follows a public → public redirect and returns the final response', async () => {
    scriptFetch((_url, hop) => hop === 0 ? redirect('http://8.8.8.8/next') : new Response('final-ok'));
    const resp = await safeFetch('http://1.1.1.1/');
    expect(await resp.text()).toBe('final-ok');
  });

  it('caps the redirect chain', async () => {
    scriptFetch(() => redirect('http://1.1.1.1/loop')); // endless same-origin public loop
    await expect(safeFetch('http://1.1.1.1/')).rejects.toThrow(/Too many redirects/);
  });

  it('303 switches to GET and drops the body', async () => {
    const calls = scriptFetch((_url, hop) => hop === 0
      ? redirect('http://1.1.1.1/result', 303)
      : new Response('done'));
    await safeFetch('http://1.1.1.1/', { method: 'POST', body: '{"a":1}' });
    expect(calls[0].method).toBe('POST');
    expect(calls[1].method).toBe('GET');
    expect(calls[1].body).toBeUndefined();
  });

  it('307 preserves method and body (e.g. https upgrade of a POST)', async () => {
    const calls = scriptFetch((_url, hop) => hop === 0
      ? redirect('http://1.1.1.1/kept', 307)
      : new Response('done'));
    await safeFetch('http://1.1.1.1/', { method: 'POST', body: '{"a":1}' });
    expect(calls[1].method).toBe('POST');
    expect(calls[1].body).toBe('{"a":1}');
  });

  it('strips Authorization on a cross-origin redirect but keeps it same-origin', async () => {
    // cross-origin: 1.1.1.1 → 8.8.8.8 → Authorization dropped
    const xo = scriptFetch((_url, hop) => hop === 0 ? redirect('http://8.8.8.8/x') : new Response('ok'));
    await safeFetch('http://1.1.1.1/', { headers: { Authorization: 'Bearer secret' } });
    expect(xo[0].auth).toBe('Bearer secret');
    expect(xo[1].auth).toBeNull();

    vi.unstubAllGlobals();

    // same-origin: 1.1.1.1 → 1.1.1.1 → Authorization kept
    const so = scriptFetch((_url, hop) => hop === 0 ? redirect('http://1.1.1.1/x') : new Response('ok'));
    await safeFetch('http://1.1.1.1/', { headers: { Authorization: 'Bearer secret' } });
    expect(so[1].auth).toBe('Bearer secret');
  });
});
