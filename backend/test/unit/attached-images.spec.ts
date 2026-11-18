import { describe, expect, it } from 'vitest';
import { AgentService } from '../../src/agent/agent.service';

function svc(support: { seesImages: boolean; describe: ((b: string, m: string) => Promise<string>) | null }) {
  const s: any = Object.create(AgentService.prototype);
  s.logger = { log() {}, debug() {}, warn() {}, error() {} };
  s.llmProviderService = { getImageSupport: async () => support };
  return s;
}

const blocks = [
  { name: 'plan.jpg', mimeType: 'image/jpeg', base64: 'AAA' },
  { name: 'doc.pdf', mimeType: 'application/pdf', base64: 'BBB' },
];

describe('attached images for the turn model', () => {
  it('go as images when the model sees them', async () => {
    const out = await svc({ seesImages: true, describe: null }).imagesForModel(blocks, [], undefined);
    expect(out.attachmentBlocks).toEqual(blocks);
    expect(out.inlineContents).toEqual([]);
  });

  it('go as they always did when no vision model is designated', async () => {
    const out = await svc({ seesImages: false, describe: null }).imagesForModel(blocks, [], undefined);
    expect(out.attachmentBlocks).toEqual(blocks);
  });

  it('go as the vision model description when the model cannot see them; PDFs untouched', async () => {
    const out = await svc({ seesImages: false, describe: async (b, m) => `a page (${b}, ${m}): Breakfast 60 g oats` })
      .imagesForModel(blocks, [{ name: 'notes.txt', content: 'hi' }], undefined);
    expect(out.attachmentBlocks).toEqual([blocks[1]]);
    expect(out.inlineContents).toHaveLength(2);
    expect(out.inlineContents[1]).toEqual({ name: 'plan.jpg', content: '[Image, described by the vision model]\na page (AAA, image/jpeg): Breakfast 60 g oats' });
  });

  it('say so when the description fails, without breaking the turn', async () => {
    const out = await svc({ seesImages: false, describe: async () => { throw new Error('vision down'); } })
      .imagesForModel(blocks, [], undefined);
    expect(out.inlineContents[0].content).toBe('[Image: it could not be described]');
  });
});
