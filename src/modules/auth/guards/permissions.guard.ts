import {
  Injectable,
  CanActivate,
  ExecutionContext,
  Inject,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';
import { DB_CONNECTION } from '../../../db/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../../db/schema';
import { eq } from 'drizzle-orm';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    @Inject(DB_CONNECTION) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user; // Exists from JwtAuthGuard

    if (!user || (!user.sub && !user.id)) {
      throw new ForbiddenException('User not found in request');
    }

    const userId = user.sub || user.id;

    // Extract user from Drizzle to get role array
    const dbUser = await this.db.query.users.findFirst({
      where: eq(schema.users.id, userId),
      with: {
        role: true,
      },
    });

    if (!dbUser) {
      throw new ForbiddenException('User does not exist');
    }

    if (!dbUser.role) {
      throw new ForbiddenException('User has no role assigned');
    }

    const userPermissions = dbUser.role.permissions || [];

    // Check if user has ALL the required permissions
    const hasPermission = requiredPermissions.every((permission) =>
      userPermissions.includes(permission),
    );

    if (!hasPermission) {
      throw new ForbiddenException('Insufficient permissions');
    }

    return true;
  }
}
