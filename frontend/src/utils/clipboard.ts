// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

// clipboard.ts — copy text to the clipboard in every deployment context.
//
// `navigator.clipboard` exists only in secure contexts (HTTPS or localhost): on a
// plain-HTTP LAN address it is undefined and every copy button silently fails.
// There we fall back to the legacy `document.execCommand('copy')` on a hidden
// textarea, which still works from a user gesture.

/** Copies `text`; resolves true on success, false if no clipboard path worked. */
export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* permission denied etc. — try the legacy path */ }
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  // Off-screen but still selectable; fixed so the page does not scroll.
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '-9999px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  const prevFocus = document.activeElement as HTMLElement | null;
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  prevFocus?.focus?.();
  return ok;
}
