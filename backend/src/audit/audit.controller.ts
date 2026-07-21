import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { AuditService } from './audit.service';

/** Audit viewer — reserved to admins. */
@ApiTags('audit')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('api/audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @ApiOperation({ summary: 'Eventi di audit (admin)' })
  list(
    @Query('action')  action?:  string,
    @Query('outcome') outcome?: string,
    @Query('actorId') actorId?: string,
    @Query('from')    from?:    string,
    @Query('to')      to?:      string,
    @Query('limit')   limit?:   string,
  ) {
    return this.audit.list({
      action, outcome, actorId, from, to,
      limit: limit ? Number(limit) : undefined,
    });
  }
}
