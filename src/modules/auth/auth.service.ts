import { Injectable, Inject, UnauthorizedException, BadRequestException, ConflictException } from '@nestjs/common';
import { DB_CONNECTION } from '../../db/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema';
import { eq } from 'drizzle-orm';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { GoogleLoginDto } from './dto/google-login.dto';

@Injectable()
export class AuthService {
    constructor(
        @Inject(DB_CONNECTION) private readonly db: NodePgDatabase<typeof schema>,
        private jwtService: JwtService,
    ) { }

    async register(dto: RegisterDto) {
        const existingUser = await this.db.query.users.findFirst({
            where: eq(schema.users.email, dto.email),
        });

        if (existingUser) {
            throw new ConflictException('Email already in use');
        }

        // Default to PARTICIPANT role
        let participantRole = await this.db.query.roles.findFirst({
            where: eq(schema.roles.name, 'PARTICIPANT'),
        });

        // Seed roles if they don't exist
        if (!participantRole) {
            participantRole = (await this.db.insert(schema.roles).values({ name: 'PARTICIPANT', permissions: [] }).returning())[0];
        }

        const hashedPassword = await bcrypt.hash(dto.password, 10);

        const [newUser] = await this.db.insert(schema.users).values({
            email: dto.email,
            password: hashedPassword,
            name: dto.name,
            roleId: participantRole.id,
        }).returning();

        return this.generateToken(newUser, participantRole);
    }

    async login(dto: LoginDto) {
        const user = await this.db.query.users.findFirst({
            where: eq(schema.users.email, dto.email),
            with: { role: true }, // Not available directly if not defined as relation, so let's fetch role separately
        });

        if (!user || !user.password) {
            throw new UnauthorizedException('Invalid credentials');
        }

        const isMatch = await bcrypt.compare(dto.password, user.password);
        if (!isMatch) {
            throw new UnauthorizedException('Invalid credentials');
        }

        const role = await this.db.query.roles.findFirst({
            where: eq(schema.roles.id, user.roleId),
        });

        return this.generateToken(user, role);
    }

    async googleLogin(dto: GoogleLoginDto) {
        // Placeholder logic for google login
        // In real app, you would verify Google token via google-auth-library
        if (dto.token === 'invalid_token') {
            throw new UnauthorizedException('Invalid google token');
        }

        // Mock scenario: user verified
        const user = { id: 1, email: 'google@user.com', name: 'Google User', roleId: 1 };

        return {
            accessToken: 'dummy_jwt_google_implementation_placeholder'
        };
    }

    private generateToken(user: any, role: any) {
        const payload = {
            sub: user.id,
            email: user.email,
            role: role?.name || 'PARTICIPANT',
            permissions: role?.permissions || []
        };
        return {
            accessToken: this.jwtService.sign(payload),
        };
    }
}
