import {
  Injectable,
  Inject,
  UnauthorizedException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
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

@Injectable()
export class AuthService {
  private googleClient: OAuth2Client;

  constructor(
    @Inject(DB_CONNECTION) private readonly db: NodePgDatabase<typeof schema>,
    private jwtService: JwtService,
  ) {
    this.googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
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
    let email = dto.email;
    let name = dto.name;
    let googleId = dto.googleId;
    let avatar = dto.avatar;

    // ── 1. Verify Google ID Token ────────────────────────────────
    try {
      const ticket = await this.googleClient.verifyIdToken({
        idToken: dto.token,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      const payload = ticket.getPayload();
      if (!payload) {
        throw new UnauthorizedException('Invalid Google token');
      }
      // Use verified data from Google
      email = payload.email!;
      googleId = payload.sub;
      name = payload.name;
      avatar = payload.picture;
    } catch (e) {
      console.error('[GoogleLogin] Verification failed:', e);
      // In a real production app, we MUST fail here.
      // For this project phase, we'll allow fallback IF token is 'dummy_token'
      // to support easy testing without real Google Play Services.
      if (dto.token !== 'dummy_token') {
        throw new UnauthorizedException('Google authentication failed');
      }
    }

    if (!email || !googleId) {
      throw new BadRequestException('Email and GoogleId are required');
    }

    let user = await this.db.query.users.findFirst({
      where: eq(schema.users.email, email),
    });

    if (user) {
      // Link Google ID if not already linked
      if (!user.googleId) {
        const [updatedUser] = await this.db
          .update(schema.users)
          .set({ googleId: googleId, avatar: avatar })
          .where(eq(schema.users.id, user.id))
          .returning();
        user = updatedUser;
      }
    } else {
      const roleId = await this.findOrCreateRole('PARTICIPANT');
      const [newUser] = await this.db
        .insert(schema.users)
        .values({
          email: email,
          name: name || 'Google User',
          googleId: googleId,
          avatar: avatar,
          roleId,
        })
        .returning();
      user = newUser;
    }

    const roleName = await this.resolveRoleName(user.roleId);
    return this.generateToken(user, roleName);
  }

  private generateToken(user: any, roleName: string) {
    const payload = {
      sub: user.id,
      email: user.email,
      role: roleName, // 'SUPER_ADMIN', 'STAFF', or 'PARTICIPANT'
    };
    const accessToken = this.jwtService.sign(payload, { expiresIn: '15m' });
    const refreshToken = this.jwtService.sign(payload, { expiresIn: '30d' });

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
      const payload = this.jwtService.verify(refreshToken);
      const user = await this.db.query.users.findFirst({
        where: eq(schema.users.id, payload.sub),
      });
      if (!user) {
        throw new UnauthorizedException('User not found');
      }
      const roleName = await this.resolveRoleName(user.roleId);
      return this.generateToken(user, roleName);
    } catch (e) {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }
}
