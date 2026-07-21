/**
 * M3 regression — POST /internal/daemons/events must take the user and daemon
 * identity from the signed daemon token (sub/did), NOT from the request body.
 * Before the fix a daemon token could spoof notifications to any user and mark
 * another tenant's daemon as exited by passing arbitrary user_id/daemon_id.
 */
import { describe, it, expect, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { InternalDaemonsController } from '../../src/daemons/internal-daemons.controller';

function makeController() {
  const daemonsSvc = { recordEvent: vi.fn(async () => {}), handleDaemonExit: vi.fn(async () => {}) };
  const notifications = { emitToUser: vi.fn() };
  const notifSvc = { create: vi.fn(async () => ({ id: 'notif-1' })) };
  const controller = new InternalDaemonsController(daemonsSvc as any, notifications as any, notifSvc as any);
  return { controller, daemonsSvc, notifications, notifSvc };
}

const body = (over: Record<string, unknown> = {}) => ({
  skill_id: 'skill-aaaaaaaa', user_id: 'victim-B', daemon_id: 'daemon-victim',
  event_type: 'new_emails', payload: {}, ...over,
});

describe('daemon events — identity from the daemon token (M3)', () => {
  it('uses token sub/did, ignoring spoofed body user_id/daemon_id', async () => {
    const { controller, daemonsSvc, notifications, notifSvc } = makeController();
    await controller.receiveEvent(body(), { internalAuth: { sub: 'owner-A', did: 'daemon-A' } });

    expect(daemonsSvc.recordEvent).toHaveBeenCalledWith('daemon-A');       // not 'daemon-victim'
    expect(notifications.emitToUser).toHaveBeenCalledWith('owner-A', 'skill_event', expect.anything()); // not 'victim-B'
    expect(notifSvc.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner-A', sourceId: 'daemon-A' }));
  });

  it('binds daemon_exit handling to the token daemon', async () => {
    const { controller, daemonsSvc } = makeController();
    await controller.receiveEvent(
      body({ event_type: 'daemon_exit', payload: { exit_code: 1 } }),
      { internalAuth: { sub: 'owner-A', did: 'daemon-A' } },
    );
    expect(daemonsSvc.handleDaemonExit).toHaveBeenCalledWith('daemon-A', 1);
  });

  it('fails closed when the token is not daemon-scoped (no did)', async () => {
    const { controller, daemonsSvc } = makeController();
    await expect(
      controller.receiveEvent(body(), { internalAuth: { sub: 'owner-A' } }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(daemonsSvc.recordEvent).not.toHaveBeenCalled();
  });
});
