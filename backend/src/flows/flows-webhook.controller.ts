/**
 * @file flows-webhook.controller.ts
 *
 * PUBLIC endpoint (no JWT) for the `webhook` trigger of the Flows.
 *
 *   POST /api/flows/webhook/:token  → executes the flow associated with the token,
 *                                     passing the request body as input.
 *
 * Authentication is the token itself (secret, generated at the creation of the flow
 * with trigger=webhook). A controller separate from FlowsController precisely to NOT
 * inherit the JwtAuthGuard.
 */
import { Controller, Post, Param, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';
import { FlowsService } from './flows.service';

@ApiTags('flows')
@Controller('api/flows/webhook')
export class FlowsWebhookController {
  constructor(private readonly service: FlowsService) {}

  @Post(':token')
  @ApiOperation({ summary: 'Esegue un flow via webhook (token pubblico)' })
  @ApiParam({ name: 'token', description: 'Token webhook del flow' })
  async run(@Param('token') token: string, @Body() body: Record<string, unknown>) {
    const run = await this.service.runByWebhookToken(token, body ?? {});
    const outputs = Object.fromEntries(
      Object.entries(run.state.nodes).map(([id, r]) => [id, (r as any).output]),
    );
    return { status: run.status, runId: run.id, outputs };
  }
}
