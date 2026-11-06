// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { Module } from '@nestjs/common';
import { ToolSourcesRegistry } from './tool-sources.registry';

/** The registry of native tool sources (tool-sources.registry.ts); no dependencies. */
@Module({ providers: [ToolSourcesRegistry], exports: [ToolSourcesRegistry] })
export class ToolSourcesModule {}
