import { Controller, Post, Body, Inject, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

class RegisterDto {
  @IsEmail() email: string;
  @IsString() name: string;
  @IsString() @MinLength(6) password: string;
}

class LoginDto {
  @IsEmail() email: string;
  @IsString() password: string;
}

@ApiTags('auth')
@Controller('api/auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  // Strict per-IP rate limit on the unauthenticated auth endpoints: blunts
  // credential brute-force / stuffing on login and mass account creation on register.
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @UseGuards(ThrottlerGuard)
  @Post('register')
  @ApiOperation({ summary: 'Register new user' })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto.email, dto.name, dto.password);
  }

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @UseGuards(ThrottlerGuard)
  @Post('login')
  @ApiOperation({ summary: 'User login' })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto.email, dto.password);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Logout — records an audit event (the JWT is stateless, dropped client-side)' })
  async logout(@CurrentUser() user: { id: string; email?: string }) {
    await this.authService.logout(user.id, user.email);
  }
}
