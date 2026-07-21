/**
 * H4 regression — GET /internal/files/search must scope the search to the identity
 * in the signed run-token (`internalAuth.sub`), NOT a caller-supplied `?userId=`.
 * Before the fix a skill running as A could read B's files with `?userId=B`.
 */
import { describe, it, expect, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { InternalFilesController } from '../../src/files/internal-files.controller';

function makeController() {
  const searchReadable = vi.fn(async (_userId: string) => [] as any[]);
  const controller = new InternalFilesController({ searchReadable } as any);
  return { controller, searchReadable };
}

describe('internal files search — identity from the token (H4)', () => {
  it('scopes the search to internalAuth.sub', async () => {
    const { controller, searchReadable } = makeController();
    await controller.search({ internalAuth: { sub: 'user-A' } }, 'q', '10');
    expect(searchReadable).toHaveBeenCalledWith('user-A', 'q', 10);
  });

  it('ignores any attacker intent — there is no userId input to spoof', async () => {
    const { controller, searchReadable } = makeController();
    // The run token identifies A; the search can only ever return A's own files.
    await controller.search({ internalAuth: { sub: 'user-A' } }, '', undefined);
    expect(searchReadable).toHaveBeenCalledWith('user-A', '', 50);
  });

  it('fails closed for an identity-less (system) token', async () => {
    const { controller, searchReadable } = makeController();
    await expect(controller.search({ internalAuth: {} }, 'q', '10')).rejects.toBeInstanceOf(ForbiddenException);
    expect(searchReadable).not.toHaveBeenCalled();
  });
});
