// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Marks a primitive a plugin contributed (specs/PLUGINS.md §5): it is managed with its plugin, so the pages that list it
 * show this badge and hide the changes the backend refuses.
 */
import { Puzzle } from 'lucide-react';

export default function PluginBadge({ label, title }: { label: string; title: string }) {
  return (
    <span title={title}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-blue-500/30 bg-blue-500/15 text-blue-400 text-xs">
      <Puzzle size={11} />{label}
    </span>
  );
}
