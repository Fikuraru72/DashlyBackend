import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface AuthenticatedUser {
  id: number;
  email: string;
  role: string;
}

export interface JwtPayload {
  sub: number;
  email?: string;
  role?: string;
  tokenType: 'access' | 'refresh';
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_SECRET'),
    });
  }

  validate(payload: JwtPayload): AuthenticatedUser {
    if (payload.tokenType !== 'access' || !payload.email || !payload.role) {
      throw new UnauthorizedException('Invalid access token');
    }

    return { id: payload.sub, email: payload.email, role: payload.role };
  }
}
