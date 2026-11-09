// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { Module } from '@nestjs/common';
import { ToolFilterCleanupService } from './tool-filter-cleanup.service';

/** No imports on purpose: every tool source module imports it, so it must not import them back. */
@Module({
  providers: [ToolFilterCleanupService],
  exports: [ToolFilterCleanupService],
})
export class ToolFiltersModule {}
