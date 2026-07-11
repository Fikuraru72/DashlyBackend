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
  constructor(
    @Inject(DB_CONNECTION) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async updateProfile(userId: number, dto: UpdateUserDto) {
    const updateData: any = { ...dto };

    if (dto.password) {
      updateData.password = await bcrypt.hash(dto.password, 10);
    }

    const [updatedUser] = await this.db
      .update(schema.users)
      .set(updateData)
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
    const allEvents = await this.db
      .select({
        distanceCovered: schema.eventParticipants.distanceCovered,
        participantState: schema.eventParticipants.participantState,
      })
      .from(schema.eventParticipants)
      .where(eq(schema.eventParticipants.userId, userId));

    const totalEvents = allEvents.length;
    const finishedEvents = allEvents.filter((e) => e.participantState === 'FINISHED');
    
    const totalDistanceMeters = finishedEvents.reduce(
      (acc, curr) => acc + (curr.distanceCovered || 0),
      0,
    );
    const totalDistance = totalDistanceMeters / 1000;

    return {
      totalDistance: parseFloat(totalDistance.toFixed(2)),
      totalEvents,
      avgSpeed: finishedEvents.length > 0 ? 12.5 : 0, // MVP placeholder
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
        ...createUserDto,
        password: hashedPassword,
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
