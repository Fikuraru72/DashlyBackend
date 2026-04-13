import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { DB_CONNECTION } from '../../db/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema';
import { eq } from 'drizzle-orm';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class UsersService {
    constructor(
        @Inject(DB_CONNECTION) private readonly db: NodePgDatabase<typeof schema>,
    ) {}

    async updateProfile(userId: number, dto: UpdateUserDto) {
        const [updatedUser] = await this.db
            .update(schema.users)
            .set({
                ...dto,
            })
            .where(eq(schema.users.id, userId))
            .returning();

        if (!updatedUser) {
            throw new NotFoundException('User not found');
        }

        return updatedUser;
    }

    async findOne(userId: number) {
        const user = await this.db.query.users.findFirst({
            where: eq(schema.users.id, userId),
        });

        if (!user) {
            throw new NotFoundException('User not found');
        }

        return user;
    }
}
