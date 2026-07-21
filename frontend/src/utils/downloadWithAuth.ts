/**
 * downloadWithAuth
 *
 * Downloads a JWT-protected file using axios (which automatically includes
 * the Authorization header) and saves it via a temporary Blob URL.
 *
 * Use it anywhere you want to download a backend file without navigating
 * directly to the URL (which would cause a 401 because the browser does not include the token).
 *
 * @param apiPath  Path relative to the axios client baseURL (e.g. "/files/abc/download")
 *                 If the path starts with "/api/", that prefix is removed automatically
 *                 because the client baseURL already includes it.
 * @param filename Suggested name for the saved file. If omitted, it is extracted
 *                 from the Content-Disposition header or from the last path segment.
 */
import api from '../api/client';

export async function downloadWithAuth(apiPath: string, filename?: string): Promise<void> {
  // Normalize the path: remove the /api prefix if present (already in the baseURL)
  const normalizedPath = apiPath.startsWith('/api/')
    ? apiPath.slice('/api'.length)
    : apiPath;

  const res = await api.get(normalizedPath, { responseType: 'blob' });

  // Try to derive the filename from the Content-Disposition header
  let resolvedName = filename;
  if (!resolvedName) {
    const cd = res.headers['content-disposition'] as string | undefined;
    if (cd) {
      const utf8Match  = cd.match(/filename\*=UTF-8''([^;]+)/i);
      const plainMatch = cd.match(/filename[^;=\n]*=["']?([^"';\n]+)["']?/i);
      resolvedName = utf8Match
        ? decodeURIComponent(utf8Match[1])
        : plainMatch?.[1]?.trim();
    }
  }

  // Fallback: use the last path segment (before the ?)
  if (!resolvedName) {
    resolvedName = normalizedPath.split('?')[0].split('/').pop() ?? 'download';
  }

  const objectUrl = URL.createObjectURL(res.data as Blob);
  const a         = document.createElement('a');
  a.href          = objectUrl;
  a.download      = resolvedName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(objectUrl), 2000);
}
