import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { DB_CONNECTION } from '../../db/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema';
import { eq, and } from 'drizzle-orm';
import { UpdateUserDto } from './dto/update-user.dto';
import { CreateUserDto } from './dto/create-user.dto';
import * as bcrypt from 'bcrypt';

@Injectable()
export class UsersService {
  constructor(@Inject(DB_CONNECTION) private readonly db: NodePgDatabase<typeof schema>) {}

  async updateProfile(userId: number, dto: UpdateUserDto) {
    const [updatedUser] = await this.db
      .update(schema.users)
      .set({
        phone: dto.phone,
        healthInfo: dto.healthInfo,
        roleId: dto.roleId,
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
      with: {
        role: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  async getUserStats(userId: number) {
    const finishedEvents = await this.db
      .select({
        distanceCovered: schema.eventParticipants.distanceCovered,
      })
      .from(schema.eventParticipants)
      .where(
        and(
          eq(schema.eventParticipants.userId, userId),
          eq(schema.eventParticipants.participantState, 'FINISHED'),
        ),
      );

    const totalEvents = finishedEvents.length;
    const totalDistanceMeters = finishedEvents.reduce(
      (acc, curr) => acc + (curr.distanceCovered || 0),
      0,
    );
    const totalDistance = totalDistanceMeters / 1000;

    return {
      totalDistance: parseFloat(totalDistance.toFixed(2)),
      totalEvents,
      avgSpeed: totalEvents > 0 ? 12.5 : 0, // MVP placeholder
      points: Math.floor(totalDistanceMeters / 100),
    };
  }

  async findAll() {
    return this.db.query.users.findMany({
      with: {
        role: true,
      },
    });
  }

  async create(createUserDto: CreateUserDto) {
    const hashedPassword = createUserDto.password
      ? await bcrypt.hash(createUserDto.password, 10)
      : undefined;

    const [user] = await this.db
      .insert(schema.users)
      .values({
        email: createUserDto.email,
        name: createUserDto.name,
        password: hashedPassword,
        roleId: createUserDto.roleId,
        phone: createUserDto.phone,
        healthInfo: createUserDto.healthInfo,
      })
      .returning();
    return user;
  }

  async remove(userId: number) {
    const [user] = await this.db
      .delete(schema.users)
      .where(eq(schema.users.id, userId))
      .returning();

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }
}
