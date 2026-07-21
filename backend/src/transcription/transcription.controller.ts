import {
  Controller, Get, Post, UploadedFile, UseInterceptors, UseGuards, Body, BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiBearerAuth, ApiConsumes, ApiBody, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { TranscriptionService } from './transcription.service';

/** Audio size limit: 25 MB (aligned with the OpenAI/Whisper limit). */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

@ApiTags('transcription')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/transcription')
export class TranscriptionController {
  constructor(private readonly service: TranscriptionService) {}

  /**
   * GET /api/transcription/status — indicates whether the microphone is enabled.
   * Accessible to every authenticated user: the frontend uses it to show or
   * hide the microphone button in chat.
   */
  @Get('status')
  @ApiOperation({ summary: 'Voice input status (enabled/disabled)' })
  async status(): Promise<{ enabled: boolean }> {
    return { enabled: await this.service.isEnabled() };
  }

  /**
   * POST /api/transcription — transcribes an audio file into text.
   * Multipart: `audio` (file), `language` (optional, ISO-639-1 hint).
   * The audio is NOT saved to disk: it stays in memory and is discarded.
   */
  @Post()
  @ApiOperation({ summary: 'Transcribes audio into text (Whisper)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        audio: { type: 'string', format: 'binary' },
        language: { type: 'string' },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('audio', {
      // No storage → memoryStorage: the buffer stays in RAM (file.buffer).
      limits: { fileSize: MAX_AUDIO_BYTES },
    }),
  )
  async transcribe(
    @UploadedFile() audio: Express.Multer.File,
    @Body('language') language?: string,
  ): Promise<{ text: string }> {
    if (!audio?.buffer?.length) {
      throw new BadRequestException('transcription.emptyAudio');
    }
    const lang = language && /^[a-z]{2}$/i.test(language) ? language.toLowerCase() : undefined;
    const text = await this.service.transcribe(audio.buffer, audio.originalname || 'audio.webm', lang);
    return { text };
  }
}
