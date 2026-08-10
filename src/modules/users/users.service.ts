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
    const updatePayload: Record<string, any> = {};
    if (dto.phone !== undefined) updatePayload.phone = dto.phone;
    if (dto.roleId !== undefined) updatePayload.roleId = dto.roleId;

    if (Object.keys(updatePayload).length > 0) {
      await this.db.update(schema.users).set(updatePayload).where(eq(schema.users.id, userId));
    }

    if (dto.healthInfo) {
      const [existingProfile] = await this.db
        .select()
        .from(schema.userHealthProfiles)
        .where(eq(schema.userHealthProfiles.userId, userId));

      if (existingProfile) {
        await this.db
          .update(schema.userHealthProfiles)
          .set({
            bloodType: dto.healthInfo.bloodType ?? existingProfile.bloodType,
            weight: dto.healthInfo.weight ?? existingProfile.weight,
            height: dto.healthInfo.height ?? existingProfile.height,
            emergencyContact: dto.healthInfo.emergencyContact ?? existingProfile.emergencyContact,
            medicalHistory: dto.healthInfo.medicalHistory ?? existingProfile.medicalHistory,
            updatedAt: new Date(),
          })
          .where(eq(schema.userHealthProfiles.userId, userId));
      } else {
        await this.db.insert(schema.userHealthProfiles).values({
          userId,
          bloodType: dto.healthInfo.bloodType,
          weight: dto.healthInfo.weight,
          height: dto.healthInfo.height,
          emergencyContact: dto.healthInfo.emergencyContact,
          medicalHistory: dto.healthInfo.medicalHistory,
        });
      }
    }

    return this.findOne(userId);
  }

  async findOne(userId: number) {
    const user = await this.db.query.users.findFirst({
      where: eq(schema.users.id, userId),
      with: {
        role: true,
        healthProfile: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const healthData = user.healthProfile
      ? {
          bloodType: user.healthProfile.bloodType,
          weight: user.healthProfile.weight,
          height: user.healthProfile.height,
          emergencyContact: user.healthProfile.emergencyContact,
          medicalHistory: user.healthProfile.medicalHistory,
        }
      : user.healthInfo;

    return {
      ...user,
      healthInfo: healthData,
      healthProfile: user.healthProfile,
    };
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
