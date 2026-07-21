/**
 * openInlineWithAuth
 *
 * Opens a file for inline VIEWING in the browser (new tab) — PDF, images,
 * audio/video — with progressive NATIVE STREAMING, even for huge files (tens of GB).
 *
 * The /api/files/stream endpoint is protected by a JWT in the header, which the browser does NOT attach
 * during direct navigation. To allow native streaming (Range requests
 * handled by the browser, without downloading the whole file) a short-lived signed TOKEN
 * bound to that file is first requested (GET /api/files/stream-token), and then the
 * direct URL is opened with `?token=...`: this way the browser authenticates via query string and
 * can seek/stream natively directly from the source (local or SMB/SFTP/
 * WebDAV), without materializing anything.
 *
 * The tab is opened IMMEDIATELY (during the click gesture) to avoid the
 * popup blocker, then pointed to the signed URL when the token is ready.
 *
 * @param viewUrl The skill's `view_url` (e.g. "/api/files/stream?source=ab12&path=...").
 *                From here `source` and `path` are extracted; the final URL adds the token.
 */
import api from '../api/client';

export async function openInlineWithAuth(viewUrl: string): Promise<void> {
  const parsed = new URL(viewUrl, window.location.origin);
  const source = parsed.searchParams.get('source');
  const path   = parsed.searchParams.get('path');
  if (!source || !path) throw new Error('openInlineWithAuth: parametri "source"/"path" mancanti');

  // Open the tab immediately (user gesture) — it will be pointed to the signed URL.
  const win = window.open('', '_blank');
  try {
    // Short-lived signed token, bound to this file (source+path).
    const res   = await api.get('/files/stream-token', { params: { source, path } });
    const token = res.data?.token as string | undefined;
    if (!token) throw new Error('openInlineWithAuth: token missing in the response');

    // DIRECT URL (self-authenticating via ?token): the browser opens it natively and does
    // progressive streaming (Range). Built from the client baseURL so as to
    // work both with the Vite proxy ('/api') and the direct backend ('http://host/api').
    const base = (api.defaults.baseURL ?? '/api').replace(/\/$/, '');
    const qp   = new URLSearchParams({ source, path, token });
    const url  = `${base}/files/stream?${qp.toString()}`;

    if (win) win.location.href = url;
    else window.open(url, '_blank');
  } catch (err) {
    if (win) win.close();
    throw err;
  }
}
