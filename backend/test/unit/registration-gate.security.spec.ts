/**
 * L6 regression — public self-service registration is closed by default. The first
 * user still bootstraps (as admin); afterwards /api/auth/register is rejected unless
 * ALLOW_PUBLIC_REGISTRATION=true.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ForbiddenException } from '@nestjs/common';

vi.mock('bcrypt', () => ({ hash: vi.fn(async () => 'h'), hashSync: vi.fn(() => 'h'), compare: vi.fn(async () => false) }));

import { AuthService } from '../../src/auth/auth.service';

function serviceWithUserCount(count: number) {
  const svc: any = Object.create(AuthService.prototype);
  svc.usersService = {
    findByEmail: vi.fn(async () => null),
    count: vi.fn(async () => count),
    create: vi.fn(async (u: any) => ({ id: 'u1', ...u })),
  };
  svc.audit = { record: vi.fn(async () => {}) };
  svc.signToken = vi.fn(() => ({ token: 't' }));
  return svc;
}

const ENV = 'ALLOW_PUBLIC_REGISTRATION';
beforeEach(() => { delete process.env[ENV]; });
afterEach(() => { delete process.env[ENV]; });

describe('registration gate (L6)', () => {
  it('allows the bootstrap first user (becomes admin) even when closed', async () => {
    const svc = serviceWithUserCount(0);
    await svc.register('admin@x.com', 'Admin', 'password');
    expect(svc.usersService.create).toHaveBeenCalledWith(expect.objectContaining({ role: 'admin' }));
  });

  it('rejects a second self-registration when public registration is closed (default)', async () => {
    const svc = serviceWithUserCount(1);
    await expect(svc.register('b@x.com', 'B', 'password')).rejects.toBeInstanceOf(ForbiddenException);
    expect(svc.usersService.create).not.toHaveBeenCalled();
  });

  it('allows registration when ALLOW_PUBLIC_REGISTRATION=true (role user)', async () => {
    process.env[ENV] = 'true';
    const svc = serviceWithUserCount(1);
    await svc.register('c@x.com', 'C', 'password');
    expect(svc.usersService.create).toHaveBeenCalledWith(expect.objectContaining({ role: 'user' }));
  });
});
