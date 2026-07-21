import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ActivityService } from './activity.service';

@ApiTags('activity')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/activity')
export class ActivityController {
  constructor(private readonly service: ActivityService) {}

  @Get()
  @ApiOperation({ summary: 'Dashboard: everything running or scheduled' })
  get(@CurrentUser() user: any) {
    return this.service.getActivity(user.id);
  }
}
