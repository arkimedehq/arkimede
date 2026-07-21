import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query,
  UseGuards, HttpCode, HttpStatus, Inject,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsOptional } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ChatsService } from './chats.service';

class CreateChatDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() projectId?: string;
  @IsOptional() @IsString() agentTeamId?: string | null;
}

class UpdateTitleDto {
  @IsString() title: string;
}

class SetAgentTeamDto {
  @IsOptional() @IsString() agentTeamId?: string | null;
}

@ApiTags('chats')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/chats')
export class ChatsController {
  constructor(@Inject(ChatsService) private readonly service: ChatsService) {}

  @Get()
  findAll(@CurrentUser() user: any, @Query('projectId') projectId?: string) {
    return this.service.findAllByUser(user.id, projectId);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.findOne(id, user.id);
  }

  @Post()
  create(@Body() dto: CreateChatDto, @CurrentUser() user: any) {
    return this.service.create(user.id, dto);
  }

  @Patch(':id/title')
  updateTitle(@Param('id') id: string, @Body() dto: UpdateTitleDto, @CurrentUser() user: any) {
    return this.service.updateTitle(id, user.id, dto.title);
  }

  @Patch(':id/agent-team')
  setAgentTeam(@Param('id') id: string, @Body() dto: SetAgentTeamDto, @CurrentUser() user: any) {
    return this.service.setAgentTeam(id, user.id, dto.agentTeamId ?? null);
  }

  /** Marks the chat as read (clears the "unread" badge in the sidebar). */
  @Patch(':id/read')
  @HttpCode(HttpStatus.OK)
  markRead(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.markRead(id, user.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.remove(id, user.id);
  }
}
