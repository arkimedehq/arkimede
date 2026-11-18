// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Voice recognition settings (admin): the switch, the voices the house knows, enrolling a voice on a satellite, each
 * voice's samples scored (the suspect ones removed one by one), the latest recognitions with their scores (to
 * calibrate), and which actions by voice need a recognised voice (clearance).
 */
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { VoiceIdService } from './voice-id.service';

class EnabledDto {
  @IsBoolean() enabled: boolean;
}

class VoiceDto {
  @IsOptional() @IsString() @MaxLength(100) name?: string;
  @IsOptional() @IsString() @MaxLength(200) haPerson?: string | null;
  @IsOptional() @IsUUID() userId?: string | null;
}

class ClearanceDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsNumber() @Min(0) @Max(1) minScore?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsUUID('all', { each: true }) people?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) @MaxLength(200, { each: true }) tools?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) @MaxLength(200, { each: true }) entities?: string[];
  @IsOptional() @IsBoolean() sensitiveTargets?: boolean;
}

class EnrollDto {
  @IsString() @MaxLength(200) satellite: string;
}

@ApiTags('voice-id')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('api/admin/voice-id')
export class VoiceIdController {
  constructor(private readonly voiceId: VoiceIdService) {}

  @Get()
  async get() {
    return {
      enabled: await this.voiceId.enabled(0), voices: await this.voiceId.list(), recognitions: this.voiceId.lastRecognitions(),
      clearance: this.voiceId.clearancePolicy(),
    };
  }

  /** Sensitive actions by voice only for a recognised voice: the policy (partial update). */
  @Put('clearance')
  async setClearance(@Body() dto: ClearanceDto) {
    await this.voiceId.setClearancePolicy(dto);
    return this.get();
  }

  @Put('enabled')
  async setEnabled(@Body() dto: EnabledDto) {
    await this.voiceId.setEnabled(dto.enabled);
    return this.get();
  }

  @Post('voices')
  create(@Body() dto: VoiceDto) {
    return this.voiceId.create({ name: dto.name ?? '', haPerson: dto.haPerson, userId: dto.userId });
  }

  @Patch('voices/:id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: VoiceDto) {
    return this.voiceId.update(id, dto);
  }

  @Delete('voices/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.voiceId.remove(id);
  }

  @Get('voices/:id/samples')
  samples(@Param('id', ParseUUIDPipe) id: string) {
    return this.voiceId.sampleScores(id);
  }

  @Delete('voices/:id/samples/:index')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeSample(@Param('id', ParseUUIDPipe) id: string, @Param('index', ParseIntPipe) index: number) {
    await this.voiceId.removeSample(id, index);
  }

  @Delete('voices/:id/samples')
  @HttpCode(HttpStatus.NO_CONTENT)
  async clearSamples(@Param('id', ParseUUIDPipe) id: string) {
    await this.voiceId.clearSamples(id);
  }

  @Post('voices/:id/enroll')
  enroll(@Param('id', ParseUUIDPipe) id: string, @Body() dto: EnrollDto) {
    return this.voiceId.enroll(id, dto.satellite);
  }

  @Delete('voices/:id/enroll')
  @HttpCode(HttpStatus.NO_CONTENT)
  cancel(@Param('id', ParseUUIDPipe) id: string) {
    this.voiceId.cancelEnrollment(id);
  }
}
