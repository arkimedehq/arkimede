import { Injectable, Inject, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { I18nContext } from 'nestjs-i18n';
import { UsersService } from '../users/users.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    @Inject(ConfigService) cfg: ConfigService,
    @Inject(UsersService) private readonly usersService: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: cfg.getOrThrow<string>('JWT_SECRET'),
    });
  }

  /**
   * Validated on every authenticated request. Besides the token signature,
   * it reloads the user from the DB so that:
   *  - a disabled account is blocked IMMEDIATELY (not at the next login)
   *  - role and data reflect the current state (e.g. admin promotion/demotion)
   * The cost is an indexed query by id: acceptable for the required security level.
   */
  async validate(payload: any) {
    const user = await this.usersService.findById(payload.sub);
    if (!user || user.status === 'disabled') {
      throw new UnauthorizedException(
        I18nContext.current()?.t('guards.sessionInvalid') ?? 'Invalid session',
      );
    }
    return { id: user.id, email: user.email, role: user.role };
  }
}
