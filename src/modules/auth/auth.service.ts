import { Injectable, Inject, UnauthorizedException, ConflictException } from '@nestjs/common';
import { DB_CONNECTION } from '../../db/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema';
import { eq } from 'drizzle-orm';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { OAuth2Client } from 'google-auth-library';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { GoogleLoginDto } from './dto/google-login.dto';
import { ConfigService } from '@nestjs/config';
import { JwtPayload } from './strategies/jwt.strategy';

@Injectable()
export class AuthService {
  private googleClient: OAuth2Client;

  constructor(
    @Inject(DB_CONNECTION) private readonly db: NodePgDatabase<typeof schema>,
    private jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    this.googleClient = new OAuth2Client(this.configService.getOrThrow<string>('GOOGLE_CLIENT_ID'));
  }

  // ── Helper: resolve role name from roleId ─────────────────────────
  private async resolveRoleName(roleId: number | null): Promise<string> {
    if (!roleId) return 'PARTICIPANT';
    const role = await this.db.query.roles.findFirst({
      where: eq(schema.roles.id, roleId),
    });
    return role?.name || 'PARTICIPANT';
  }

  // ── Helper: find or create role by name ───────────────────────────
  private async findOrCreateRole(roleName: string): Promise<number> {
    let role = await this.db.query.roles.findFirst({
      where: eq(schema.roles.name, roleName),
    });
    if (!role) {
      const [inserted] = await this.db
        .insert(schema.roles)
        .values({ name: roleName, permissions: [] })
        .returning();
      role = inserted;
    }
    return role.id;
  }

  async register(dto: RegisterDto) {
    const existingUser = await this.db.query.users.findFirst({
      where: eq(schema.users.email, dto.email),
    });

    if (existingUser) {
      throw new ConflictException('Email already in use');
    }

    const roleId = await this.findOrCreateRole('PARTICIPANT');
    const hashedPassword = await bcrypt.hash(dto.password, 10);

    const [newUser] = await this.db
      .insert(schema.users)
      .values({
        email: dto.email,
        password: hashedPassword,
        name: dto.name,
        phone: dto.phone,
        healthInfo: dto.healthInfo ?? null,
        roleId,
      })
      .returning();

    return this.generateToken(newUser, 'PARTICIPANT');
  }

  async login(dto: LoginDto) {
    const user = await this.db.query.users.findFirst({
      where: eq(schema.users.email, dto.email),
    });

    if (!user || !user.password) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isMatch = await bcrypt.compare(dto.password, user.password);
    if (!isMatch) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const roleName = await this.resolveRoleName(user.roleId);
    return this.generateToken(user, roleName);
  }

  async googleLogin(dto: GoogleLoginDto) {
    let payload;
    try {
      const ticket = await this.googleClient.verifyIdToken({
        idToken: dto.token,
        audience: this.configService.getOrThrow<string>('GOOGLE_CLIENT_ID'),
      });
      payload = ticket.getPayload();
    } catch {
      throw new UnauthorizedException('Google authentication failed');
    }

    if (!payload?.email || !payload.email_verified || !payload.sub) {
      throw new UnauthorizedException('Invalid Google identity');
    }

    const { email, sub: googleId, name, picture: avatar } = payload;
    let user = await this.db.query.users.findFirst({
      where: eq(schema.users.email, email),
    });

    if (user) {
      if (user.googleId && user.googleId !== googleId) {
        throw new UnauthorizedException('Google account does not match');
      }
      if (!user.googleId) {
        const [updatedUser] = await this.db
          .update(schema.users)
          .set({ googleId, avatar })
          .where(eq(schema.users.id, user.id))
          .returning();
        user = updatedUser;
      }
    } else {
      const roleId = await this.findOrCreateRole('PARTICIPANT');
      const [newUser] = await this.db
        .insert(schema.users)
        .values({
          email,
          name: name || 'Google User',
          googleId,
          avatar,
          roleId,
        })
        .returning();
      user = newUser;
    }

    const roleName = await this.resolveRoleName(user.roleId);
    return this.generateToken(user, roleName);
  }

  private generateToken(user: typeof schema.users.$inferSelect, roleName: string) {
    const accessToken = this.jwtService.sign(
      { sub: user.id, email: user.email, role: roleName, tokenType: 'access' },
      { expiresIn: '15m' },
    );
    const refreshToken = this.jwtService.sign(
      { sub: user.id, tokenType: 'refresh' },
      { expiresIn: '30d' },
    );

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: roleName,
        avatar: user.avatar,
      },
      accessToken,
      refreshToken,
    };
  }

  async refresh(refreshToken: string) {
    try {
      const payload = this.jwtService.verify<JwtPayload>(refreshToken);
      if (payload.tokenType !== 'refresh') {
        throw new UnauthorizedException('Invalid refresh token');
      }
      const user = await this.db.query.users.findFirst({
        where: eq(schema.users.id, payload.sub),
      });
      if (!user) {
        throw new UnauthorizedException('User not found');
      }
      const roleName = await this.resolveRoleName(user.roleId);
      return this.generateToken(user, roleName);
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }
}
