// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file recordare-procedures.ts
 *
 * Reports from code how a run of a Recordare procedure went (Recordare API.md §4d, `reportProcedureRun`), for work
 * Arkimede's own code carries out without the model in the loop (e.g. a sequence): the model cannot report an outcome
 * it never sees. Work the model drives is reported by the model itself with `recordare_report_procedure_run`, as the
 * memory charter asks.
 *
 * A plain function on the shared client (like recordare-outbox.ts) on purpose: the callers need no Nest import of the
 * Recordare module. Best effort: Recordare not configured → nothing; a failure is logged, never thrown.
 */
import { Logger } from '@nestjs/common';
import { type ProcedureRun } from '@arkimedehq/recordare-client';
import { recordareClient } from './recordare.config';

const logger = new Logger('RecordareProcedures');

/** Longest `note` sent (what went wrong, short). */
export const PROCEDURE_NOTE_MAX = 500;

/** A procedure of the memory a piece of work carries out: its id, and the step when it is one step of it. */
export interface ProcedureRef {
  id: string;
  step?: number;
}

/**
 * Sends one run of procedure `procedureId` for `userId`; `chatId` is the conversation it happened in (the externalId
 * Arkimede ingests the chat under), so Recordare knows who was there. True when Recordare took it.
 */
export async function reportProcedureRun(
  userId: string, procedureId: string, run: Omit<ProcedureRun, 'conversation'>, chatId?: string | null,
): Promise<boolean> {
  const client = recordareClient();
  if (!client) return false;
  try {
    await client.reportProcedureRun(userId, procedureId, {
      outcome: run.outcome,
      ...(run.step !== undefined ? { step: run.step } : {}),
      ...(run.note ? { note: run.note.slice(0, PROCEDURE_NOTE_MAX) } : {}),
      ...(chatId ? { conversation: { externalId: chatId } } : {}),
    });
    logger.log(`Procedure ${procedureId} run reported: ${run.outcome}${run.step !== undefined ? ` at step ${run.step}` : ''} (user ${userId})`);
    return true;
  } catch (err: any) {
    logger.warn(`Procedure ${procedureId} run not reported (user ${userId}): ${err?.message ?? err}`);
    return false;
  }
}
