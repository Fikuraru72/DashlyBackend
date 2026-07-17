import { Controller, Patch, Body, UseGuards, Get, Post, Delete, Param } from '@nestjs/common';
import { UsersService } from './users.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  async getProfile(@CurrentUser() user: any) {
    // user.sub is often the id in NestJS JWT strategies
    return this.usersService.findOne(user.sub || user.id);
  }

  @Get('me/stats')
  async getMyStats(@CurrentUser() user: any) {
    const userId = user.sub || user.id;
    return this.usersService.getUserStats(userId);
  }

  @Patch('me')
  async updateProfile(@CurrentUser() user: any, @Body() dto: UpdateUserDto) {
    // Extracting userId from payload.
    // In the existing generateToken, the userId is logged as 'sub'.
    const userId = user.sub || user.id;
    return this.usersService.updateProfile(userId, dto);
  }

  // --- Admin Routes ---
  @Get()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('manage_users')
  async findAll() {
    return this.usersService.findAll();
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('manage_users')
  async create(@Body() dto: CreateUserDto) {
    return this.usersService.create(dto);
  }

  @Patch(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('manage_users')
  async update(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.usersService.updateProfile(+id, dto);
  }

  @Delete(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('manage_users')
  async remove(@Param('id') id: string) {
    return this.usersService.remove(+id);
  }
}
