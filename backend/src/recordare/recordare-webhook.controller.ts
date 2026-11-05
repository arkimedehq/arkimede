// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file recordare-webhook.controller.ts
 *
 * `POST api/recordare/webhook` — where Recordare pushes the memory's initiatives (Standard Webhooks). Public (no JWT:
 * Recordare is the caller), authenticated by the signature: the raw body (kept by main.ts for this route only) is
 * verified with the library's `verifyWebhook` and the endpoint's `whsec_` secret (Settings → Memory → Recordare
 * initiatives, or RECORDARE_WEBHOOK_SECRET; given when the admin registered the webhook on Recordare). Off (404)
 * without the secret or without Recordare. Answers 204 at once; the delivery runs afterwards (Recordare retries a failed POST, never a slow one).
 */
import { Controller, Headers, HttpCode, NotFoundException, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { verifyWebhook, type WebhookEvent } from '@arkimedehq/recordare-client';
import { noteRecordareWebhook, recordareConfig, recordareWebhookSecret } from './recordare.config';
import { RecordareInitiativesService } from './recordare-initiatives.service';

export const RECORDARE_WEBHOOK_PATH = '/api/recordare/webhook';

@Controller('api/recordare/webhook')
export class RecordareWebhookController {
  constructor(private readonly initiatives: RecordareInitiativesService) {}

  @Post()
  @HttpCode(204)
  receive(@Req() req: Request & { rawBody?: Buffer }, @Headers() headers: Record<string, string>): void {
    const secret = recordareWebhookSecret();
    if (!secret || !recordareConfig()) throw new NotFoundException();
    let event: WebhookEvent;
    try {
      event = verifyWebhook(req.rawBody ?? Buffer.alloc(0), headers, secret);
    } catch {
      throw new UnauthorizedException();
    }
    noteRecordareWebhook(event.type);
    setImmediate(() => void this.initiatives.handleEvent(event));
  }
}
