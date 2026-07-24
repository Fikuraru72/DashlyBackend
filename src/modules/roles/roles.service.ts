import { Injectable, Inject, NotFoundException, ConflictException } from '@nestjs/common';
import { DB_CONNECTION } from '../../db/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema';
import { eq } from 'drizzle-orm';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';

@Injectable()
export class RolesService {
  constructor(@Inject(DB_CONNECTION) private readonly db: NodePgDatabase<typeof schema>) {}

  async create(createRoleDto: CreateRoleDto) {
    try {
      const [role] = await this.db
        .insert(schema.roles)
        .values({
          name: createRoleDto.name,
          permissions: createRoleDto.permissions || [],
        })
        .returning();
      return role;
    } catch (error: any) {
      if (error.code === '23505') {
        // Postgres unique violation code
        throw new ConflictException('Role with this name already exists');
      }
      throw error;
    }
  }

  async findAll() {
    return this.db.query.roles.findMany();
  }

  async findOne(id: number) {
    const role = await this.db.query.roles.findFirst({
      where: eq(schema.roles.id, id),
    });

    if (!role) {
      throw new NotFoundException(`Role with ID ${id} not found`);
    }

    return role;
  }

  async update(id: number, updateRoleDto: UpdateRoleDto) {
    try {
      const [role] = await this.db
        .update(schema.roles)
        .set({
          name: updateRoleDto.name,
          permissions: updateRoleDto.permissions,
        })
        .where(eq(schema.roles.id, id))
        .returning();

      if (!role) {
        throw new NotFoundException(`Role with ID ${id} not found`);
      }

      return role;
    } catch (error: any) {
      if (error.code === '23505') {
        throw new ConflictException('Role with this name already exists');
      }
      throw error;
    }
  }

  async remove(id: number) {
    const [role] = await this.db.delete(schema.roles).where(eq(schema.roles.id, id)).returning();

    if (!role) {
      throw new NotFoundException(`Role with ID ${id} not found`);
    }

    return role;
  }
}
