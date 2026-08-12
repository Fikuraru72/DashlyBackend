import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { DB_CONNECTION } from '../../db/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { UpdateUserDto } from './dto/update-user.dto';
import { CreateUserDto } from './dto/create-user.dto';
import * as bcrypt from 'bcrypt';

@Injectable()
export class UsersService {
  constructor(@Inject(DB_CONNECTION) private readonly db: NodePgDatabase<typeof schema>) {}

  async updateProfile(userId: number, dto: UpdateUserDto) {
    const updatePayload: Record<string, any> = {};
    if (dto.name !== undefined) updatePayload.name = dto.name;
    if (dto.phone !== undefined && dto.phone.trim() !== '') updatePayload.phone = dto.phone;
    if (dto.roleId !== undefined) updatePayload.roleId = dto.roleId;
    if (dto.avatar !== undefined) updatePayload.avatar = dto.avatar;
    if (dto.password !== undefined && dto.password.trim() !== '') {
      updatePayload.password = await bcrypt.hash(dto.password, 10);
    }

    if (Object.keys(updatePayload).length > 0) {
      await this.db.update(schema.users).set(updatePayload).where(eq(schema.users.id, userId));
    }

    if (dto.healthInfo) {
      const [existingProfile] = await this.db
        .select()
        .from(schema.userHealthProfiles)
        .where(eq(schema.userHealthProfiles.userId, userId));

      const emName =
        dto.healthInfo.emergencyName !== undefined
          ? dto.healthInfo.emergencyName
          : (existingProfile?.emergencyName ?? null);
      const emPhone =
        dto.healthInfo.emergencyPhone !== undefined
          ? dto.healthInfo.emergencyPhone
          : (existingProfile?.emergencyPhone ?? null);
      const emRel =
        dto.healthInfo.emergencyRelation !== undefined
          ? dto.healthInfo.emergencyRelation
          : (existingProfile?.emergencyRelation ?? null);

      let formattedContact = dto.healthInfo.emergencyContact;
      if (emName || emPhone || emRel) {
        const parts: string[] = [];
        if (emName) parts.push(emName);
        if (emRel) parts.push(`(${emRel})`);
        if (emPhone) parts.push(`- ${emPhone}`);
        if (parts.length > 0) {
          formattedContact = parts.join(' ');
        }
      }

      if (existingProfile) {
        await this.db
          .update(schema.userHealthProfiles)
          .set({
            bloodType: dto.healthInfo.bloodType ?? existingProfile.bloodType,
            weight: dto.healthInfo.weight ?? existingProfile.weight,
            height: dto.healthInfo.height ?? existingProfile.height,
            emergencyName: emName,
            emergencyPhone: emPhone,
            emergencyRelation: emRel,
            emergencyContact: formattedContact ?? existingProfile.emergencyContact,
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
          emergencyName: emName,
          emergencyPhone: emPhone,
          emergencyRelation: emRel,
          emergencyContact: formattedContact,
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
          emergencyName: user.healthProfile.emergencyName,
          emergencyPhone: user.healthProfile.emergencyPhone,
          emergencyRelation: user.healthProfile.emergencyRelation,
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
    const allUsers = await this.db.query.users.findMany({
      with: {
        role: true,
        healthProfile: true,
      },
    });

    return allUsers.map((user) => {
      const healthData = user.healthProfile
        ? {
            bloodType: user.healthProfile.bloodType,
            weight: user.healthProfile.weight,
            height: user.healthProfile.height,
            emergencyName: user.healthProfile.emergencyName,
            emergencyPhone: user.healthProfile.emergencyPhone,
            emergencyRelation: user.healthProfile.emergencyRelation,
            emergencyContact: user.healthProfile.emergencyContact,
            medicalHistory: user.healthProfile.medicalHistory,
          }
        : user.healthInfo;

      return {
        ...user,
        healthInfo: healthData,
        healthProfile: user.healthProfile,
      };
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
      })
      .returning();

    if (createUserDto.healthInfo) {
      const hInfo = createUserDto.healthInfo as Record<string, any>;
      const emName = hInfo.emergencyName || hInfo.emergencyContactName || null;
      const emPhone =
        hInfo.emergencyPhone || hInfo.emergencyContactPhone || hInfo.emergency_phone || null;
      const emRel = hInfo.emergencyRelation || null;

      let formattedContact = hInfo.emergencyContact;
      if (emName || emPhone || emRel) {
        const parts: string[] = [];
        if (emName) parts.push(emName);
        if (emRel) parts.push(`(${emRel})`);
        if (emPhone) parts.push(`- ${emPhone}`);
        if (parts.length > 0) formattedContact = parts.join(' ');
      }

      await this.db.insert(schema.userHealthProfiles).values({
        userId: user.id,
        bloodType: hInfo.bloodType || hInfo.blood_type,
        weight: hInfo.weight
          ? parseFloat(hInfo.weight)
          : hInfo.weight_kg
            ? parseFloat(hInfo.weight_kg)
            : null,
        height: hInfo.height
          ? parseFloat(hInfo.height)
          : hInfo.height_cm
            ? parseFloat(hInfo.height_cm)
            : null,
        emergencyName: emName,
        emergencyPhone: emPhone,
        emergencyRelation: emRel,
        emergencyContact: formattedContact,
        medicalHistory:
          hInfo.medicalHistory ||
          (Array.isArray(hInfo.medicalConditions)
            ? hInfo.medicalConditions.join(', ')
            : hInfo.medicalConditions),
      });
    }

    return this.findOne(user.id);
  }

  async remove(userId: number) {
    const user = await this.db.query.users.findFirst({
      where: eq(schema.users.id, userId),
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    await this.db.transaction(async (tx) => {
      await tx.delete(schema.eventParticipants).where(eq(schema.eventParticipants.userId, userId));
      await tx
        .delete(schema.userHealthProfiles)
        .where(eq(schema.userHealthProfiles.userId, userId));
      await tx.delete(schema.rankings).where(eq(schema.rankings.userId, userId));
      await tx.delete(schema.anomalies).where(eq(schema.anomalies.userId, userId));
      await tx.delete(schema.locationLogs).where(eq(schema.locationLogs.userId, userId));
      await tx.delete(schema.tokens).where(eq(schema.tokens.userId, userId));
      await tx.delete(schema.users).where(eq(schema.users.id, userId));
    });

    return user;
  }

  async removeAllParticipants() {
    let deletedCount = 0;

    await this.db.transaction(async (tx) => {
      // Find all participant users (or non-admin/staff users)
      const participantUsers = await tx.query.users.findMany({
        with: { role: true },
      });

      const idsToDelete = participantUsers
        .filter((u) => !u.role || u.role.name === 'PARTICIPANT')
        .map((u) => u.id);

      if (idsToDelete.length === 0) return;

      for (const id of idsToDelete) {
        await tx.delete(schema.eventParticipants).where(eq(schema.eventParticipants.userId, id));
        await tx.delete(schema.userHealthProfiles).where(eq(schema.userHealthProfiles.userId, id));
        await tx.delete(schema.rankings).where(eq(schema.rankings.userId, id));
        await tx.delete(schema.anomalies).where(eq(schema.anomalies.userId, id));
        await tx.delete(schema.locationLogs).where(eq(schema.locationLogs.userId, id));
        await tx.delete(schema.tokens).where(eq(schema.tokens.userId, id));
        await tx.delete(schema.users).where(eq(schema.users.id, id));
      }

      // Reset currentCount for events if needed
      await tx.execute(
        sql`UPDATE events SET current_count = (SELECT COUNT(*) FROM event_participants WHERE event_id = events.id)`,
      );

      deletedCount = idsToDelete.length;
    });

    return { success: true, count: deletedCount };
  }
}
