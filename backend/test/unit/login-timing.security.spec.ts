/**
 * L5 regression — login must spend the same CPU on an unknown email as on a wrong
 * password (a dummy bcrypt compare), so response timing can't be used to enumerate
 * which emails are registered. Both paths must invoke bcrypt.compare and return the
 * same generic UnauthorizedException.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';

vi.mock('bcrypt', () => ({
  compare: vi.fn(async () => false),
  hashSync: vi.fn(() => '$2b$12$0000000000000000000000000000000000000000000000000000'),
  hash: vi.fn(async () => 'hash'),
}));

import * as bcrypt from 'bcrypt';
import { AuthService } from '../../src/auth/auth.service';

function service(user: any) {
  const svc: any = Object.create(AuthService.prototype);
  svc.usersService = { findByEmail: vi.fn(async () => user) };
  svc.audit = { record: vi.fn(async () => {}) };
  return svc;
}

beforeEach(() => (bcrypt.compare as any).mockClear());

describe('login timing — no user enumeration (L5)', () => {
  it('runs a bcrypt compare even for an unknown email', async () => {
    const svc = service(null);
    await expect(svc.login('nobody@example.com', 'pw')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(bcrypt.compare).toHaveBeenCalledTimes(1); // dummy compare burned the same CPU as a real one
  });

  it('returns the same generic error for a wrong password (existing user)', async () => {
    const svc = service({ id: 'u1', email: 'real@example.com', password: 'hash', status: 'active' });
    await expect(svc.login('real@example.com', 'wrong')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(bcrypt.compare).toHaveBeenCalledTimes(1);
  });
});
