/**
 * @file auth.service.ts
 *
 * Authentication service with JWT and bcrypt.
 *
 * Exposes three operations:
 *   - register() → creates a new user with a hashed password and returns a token
 *   - login()    → verifies the credentials and returns a token
 *   - signToken()→ private helper for JWT generation
 *
 * Security:
 *   - Passwords are hashed with bcrypt at 12 rounds (high cost, ~300ms/hash)
 *     to resist offline brute-force attacks.
 *   - The JWT token contains only id, email and role (no sensitive data).
 *   - The error message for invalid login is generic ("Credenziali non valide")
 *     both for a non-existent email and a wrong password, to prevent user enumeration.
 *
 * The JWT is signed with the JWT_SECRET key from ConfigService and its lifetime
 * is configured in JwtModule (see auth.module.ts).
 */
import { Injectable, Inject, Optional, UnauthorizedException, ConflictException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';
import { AuditService } from '../audit/audit.service';

/**
 * A valid bcrypt hash (cost 12) used only to spend the same CPU on an unknown-email
 * login as on a real one — so response time does not reveal whether an email exists.
 * Computed once at load; the plaintext is irrelevant (it never matches a submission).
 */
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('unknown-user-timing-equalizer', 12);

@Injectable()
export class AuthService {
  constructor(
    @Inject(UsersService) private readonly usersService: UsersService,
    @Inject(JwtService)   private readonly jwtService:   JwtService,
    @Optional() private readonly audit?: AuditService,
  ) {}

  /**
   * Registers a new user.
   *
   * @throws ConflictException if the email is already registered
   * @returns JWT token + user data (without password)
   */
  async register(email: string, name: string, password: string) {
    const existing = await this.usersService.findByEmail(email);
    if (existing) throw new ConflictException('errors.emailTaken');

    // Bootstrap: the FIRST registered user becomes the org administrator.
    // All subsequent ones are normal users (an admin can promote them).
    const isFirstUser = (await this.usersService.count()) === 0;

    // Public self-service registration is CLOSED by default: after bootstrap, new
    // accounts are created by an admin unless ALLOW_PUBLIC_REGISTRATION=true. Blunts
    // account spam / unwanted enrolment on internet-facing deployments.
    const publicRegOpen = (process.env.ALLOW_PUBLIC_REGISTRATION ?? 'false').toLowerCase() === 'true';
    if (!isFirstUser && !publicRegOpen) {
      await this.audit?.record({ action: 'auth.register', resource: email, outcome: 'denied', ctx: { reason: 'registration_closed' } });
      throw new ForbiddenException('errors.registrationClosed');
    }

    // bcrypt with 12 rounds: high computational cost to slow down brute-force
    const hash = await bcrypt.hash(password, 12);
    const role = isFirstUser ? 'admin' : 'user';

    const user  = await this.usersService.create({ email, name, password: hash, role });

    await this.audit?.record({
      actorId: user.id, actorName: user.email, action: 'auth.register',
      resource: email, outcome: 'ok', ctx: { userId: user.id, role, firstUser: isFirstUser },
    });
    return this.signToken(user);
  }

  /**
   * Authenticates an existing user.
   *
   * Uses the same error message for a non-existent email and a wrong password
   * to prevent user enumeration (an attacker cannot know whether the email exists).
   *
   * @throws UnauthorizedException if email not found or password does not match
   * @returns JWT token + user data (without password)
   */
  async login(email: string, password: string) {
    const user = await this.usersService.findByEmail(email);

    // Intentionally generic message AND constant-time: run a dummy bcrypt compare so
    // an unknown email costs the same as a wrong password → no timing enumeration.
    if (!user) {
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
      await this.audit?.record({ action: 'auth.login', resource: email, outcome: 'denied', ctx: { reason: 'unknown_email' } });
      throw new UnauthorizedException('errors.invalidCredentials');
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      await this.audit?.record({ actorId: user.id, action: 'auth.login', resource: email, outcome: 'denied', ctx: { reason: 'bad_password' } });
      throw new UnauthorizedException('errors.invalidCredentials');
    }

    // Account disabled by the admin: login rejected with a dedicated message.
    if (user.status === 'disabled') {
      await this.audit?.record({ actorId: user.id, action: 'auth.login', resource: email, outcome: 'denied', ctx: { reason: 'disabled' } });
      throw new ForbiddenException('errors.accountDisabled');
    }

    await this.audit?.record({
      actorId: user.id, actorName: user.email, action: 'auth.login',
      resource: email, outcome: 'ok', ctx: { role: user.role },
    });
    return this.signToken(user);
  }

  /**
   * Logout: the JWT is stateless (dropped client-side), so this only records the
   * security event for the audit trail.
   */
  async logout(userId: string, actorName?: string): Promise<void> {
    await this.audit?.record({
      actorId: userId, actorName, action: 'auth.logout', resource: userId, outcome: 'ok',
    });
  }

  /**
   * Generates the JWT for an authenticated user.
   *
   * Minimal payload for security: only the data needed by the auth middleware
   * (sub = user id, email, role). Do not include sensitive data in the token
   * because it is decodable client-side (even if not modifiable).
   *
   * @param user - User entity from the database
   */
  private signToken(user: any) {
    const payload = { sub: user.id, email: user.email, role: user.role };
    return {
      access_token: this.jwtService.sign(payload),
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    };
  }
}
