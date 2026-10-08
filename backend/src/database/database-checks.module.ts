// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { Module } from '@nestjs/common';
import { PostgresCollationCheck } from './postgres-collation.check';

/** Start-up checks on the database itself (warnings only, never blocking). */
@Module({ providers: [PostgresCollationCheck] })
export class DatabaseChecksModule {}
