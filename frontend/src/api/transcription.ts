import api from './client';

export const transcriptionApi = {
  /** GET /api/transcription/status — true if the microphone is enabled by the admin. */
  status: (): Promise<{ enabled: boolean }> =>
    api.get('/transcription/status').then((r) => r.data),

  /**
   * POST /api/transcription — sends an audio blob and receives the transcribed text.
   * @param audio    blob recorded by the browser (webm/opus)
   * @param language ISO-639-1 language hint (e.g. 'it') to improve accuracy
   */
  transcribe: async (audio: Blob, language?: string): Promise<string> => {
    const form = new FormData();
    form.append('audio', audio, 'recording.webm');
    if (language) form.append('language', language);
    const { data } = await api.post('/transcription', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return data.text ?? '';
  },
};
