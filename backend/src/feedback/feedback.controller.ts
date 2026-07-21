import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query,
  UseGuards, Inject,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsBoolean, IsUUID } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { FeedbackService } from './feedback.service';
import { FeedbackRating, FeedbackScope } from './feedback.entity';

class CreateFeedbackDto {
  @IsUUID() messageId: string;
  @IsIn(['up', 'down']) rating: FeedbackRating;
  @IsOptional() @IsString() comment?: string;
  @IsOptional() @IsIn(['personal', 'shared']) scope?: FeedbackScope;
}

class SetEnabledDto {
  @IsBoolean() enabled: boolean;
}

class ApproveDto {
  @IsBoolean() approved: boolean;
}

class SetScopeDto {
  @IsIn(['personal', 'shared']) scope: FeedbackScope;
}

@ApiTags('feedback')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/feedback')
export class FeedbackController {
  constructor(
    @Inject(FeedbackService) private readonly feedbackService: FeedbackService,
  ) {}

  /** Feedback-memory state (to show/hide the buttons in the UI). */
  @Get('config')
  @ApiOperation({ summary: 'Feedback-memory state (enabled, vectorAvailable)' })
  getConfig() {
    return this.feedbackService.getConfig();
  }

  /** Enables/disables the memory (admin). On activation it creates the collection. */
  @Patch('config')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Enable/disable feedback-memory (admin)' })
  setEnabled(@Body() dto: SetEnabledDto) {
    return this.feedbackService.setEnabled(dto.enabled);
  }

  /** Submits/updates feedback on an assistant message. */
  @Post()
  @ApiOperation({ summary: 'Submit feedback 👍/👎 (+ correction)' })
  create(@CurrentUser() user: any, @Body() dto: CreateFeedbackDto) {
    return this.feedbackService.createOrUpdate(user.id, dto);
  }

  /** User's feedback for the messages of a chat (UI state restore). */
  @Get('chat/:chatId')
  @ApiOperation({ summary: 'My feedback for a chat' })
  listForChat(@CurrentUser() user: any, @Param('chatId') chatId: string) {
    return this.feedbackService.listForChat(user.id, chatId);
  }

  /** Dashboard: admin sees everything, user only their own. */
  @Get()
  @ApiOperation({ summary: 'Feedback list (dashboard)' })
  list(@CurrentUser() user: any) {
    return this.feedbackService.list(user.id, user.role === 'admin');
  }

  /** Approves/revokes a shared feedback (admin). */
  @Patch(':id/approve')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Approve shared feedback (admin)' })
  approve(@Param('id') id: string, @Body() dto: ApproveDto) {
    return this.feedbackService.approve(id, dto.approved);
  }

  /** Changes personal/shared scope (owner or admin). */
  @Patch(':id/scope')
  @ApiOperation({ summary: 'Change feedback scope' })
  setScope(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: SetScopeDto) {
    return this.feedbackService.setScope(id, dto.scope, user.id, user.role === 'admin');
  }

  /** Deletes a feedback (owner or admin). */
  @Delete(':id')
  @ApiOperation({ summary: 'Delete feedback' })
  async remove(@CurrentUser() user: any, @Param('id') id: string) {
    await this.feedbackService.remove(id, user.id, user.role === 'admin');
    return { ok: true };
  }
}
