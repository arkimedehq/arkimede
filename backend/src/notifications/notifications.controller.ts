/**
 * @file notifications.controller.ts
 *
 * REST API for the authenticated user's notifications.
 *
 * Base: /api/notifications
 *
 *   GET    /               — list notifications (max 100, most recent first)
 *   PATCH  /read-all       — mark all as read
 *   PATCH  /:id/read       — mark one as read
 *   DELETE /               — delete all
 *   DELETE /:id            — delete one
 */
import {
  Controller, Get, Patch, Delete, Param, Query,
  UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard }     from '../common/guards/jwt-auth.guard';
import { CurrentUser }      from '../common/decorators/current-user.decorator';
import { NotificationsService } from './notifications.service';

@UseGuards(JwtAuthGuard)
@Controller('api/notifications')
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  /** Returns the user's latest notifications (default 100). */
  @Get()
  list(
    @CurrentUser() user: any,
    @Query('limit') limit?: string,
  ) {
    const n = limit ? Math.min(parseInt(limit, 10) || 100, 200) : 100;
    return this.svc.findByUser(user.id, n);
  }

  /** Marks all the user's notifications as read. */
  @Patch('read-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markAllRead(@CurrentUser() user: any): Promise<void> {
    await this.svc.markAllRead(user.id);
  }

  /** Marks one notification as read. */
  @Patch(':id/read')
  markRead(@CurrentUser() user: any, @Param('id') id: string) {
    return this.svc.markRead(user.id, id);
  }

  /** Deletes all the user's notifications. */
  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteAll(@CurrentUser() user: any): Promise<void> {
    await this.svc.deleteAll(user.id);
  }

  /** Deletes a specific notification. */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteOne(@CurrentUser() user: any, @Param('id') id: string): Promise<void> {
    await this.svc.delete(user.id, id);
  }
}
