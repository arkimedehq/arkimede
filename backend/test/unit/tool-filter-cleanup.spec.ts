// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Tool filters after a source is deleted: its wildcard and tools go, everything
 * else stays — namesakes of other users, longer prefixes of other sources.
 */
import { describe, it, expect } from 'vitest';
import { pruneToolFilterNames } from '../../src/tool-filters/tool-filter-cleanup.service';

describe('pruneToolFilterNames', () => {
  const filter = [
    'mcp_home_*', 'mcp_home_lights', 'mcp_home_assistant_*', 'mcp_home_assistant_GetLiveContext',
    'skill_files_read_py', 'web_search', 'flow_daily_report',
  ];

  it('removes a deleted source\'s wildcard and tools', () => {
    expect(pruneToolFilterNames(filter, {
      prefix: 'mcp_home_', remaining: ['mcp_home_assistant_', 'mcp_other_'],
    })).toEqual(['mcp_home_assistant_*', 'mcp_home_assistant_GetLiveContext', 'skill_files_read_py', 'web_search', 'flow_daily_report']);
  });

  it('removes everything under the prefix when no longer prefix remains', () => {
    expect(pruneToolFilterNames(['mcp_home_*', 'mcp_home_assistant_*', 'web_search'], { prefix: 'mcp_home_', remaining: [] }))
      .toEqual(['web_search']);
  });

  it('keeps the entries while a namesake source remains', () => {
    expect(pruneToolFilterNames(filter, { prefix: 'mcp_home_', remaining: ['mcp_home_'] })).toEqual(filter);
    expect(pruneToolFilterNames(filter, { names: ['flow_daily_report'], remaining: ['flow_daily_report'] })).toEqual(filter);
  });

  it('removes exact tool names', () => {
    expect(pruneToolFilterNames(filter, { names: ['flow_daily_report', 'web_search'], remaining: [] }))
      .toEqual(filter.slice(0, 5));
  });

  it('leaves a filter without the source untouched', () => {
    expect(pruneToolFilterNames(['web_search'], { prefix: 'skill_files_', remaining: [] })).toEqual(['web_search']);
  });
});
