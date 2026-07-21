import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';

/**
 * Guard that restricts access to users with the 'admin' role only.
 * It must be used AFTER JwtAuthGuard (which populates req.user).
 *
 * Usage:
 *   @UseGuards(JwtAuthGuard, AdminGuard)
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    if (req.user?.role !== 'admin') {
      throw new ForbiddenException('guards.adminOnly');
    }
    return true;
  }
}
