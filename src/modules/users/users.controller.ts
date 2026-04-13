import { Controller, Patch, Body, UseGuards, Get } from '@nestjs/common';
import { UsersService } from './users.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
    constructor(private readonly usersService: UsersService) {}

    @Get('me')
    async getProfile(@CurrentUser() user: any) {
        // user.sub is often the id in NestJS JWT strategies
        return this.usersService.findOne(user.sub || user.id);
    }

    @Patch('me')
    async updateProfile(
        @CurrentUser() user: any,
        @Body() dto: UpdateUserDto,
    ) {
        // Extracting userId from payload. 
        // In the existing generateToken, the userId is logged as 'sub'.
        const userId = user.sub || user.id;
        return this.usersService.updateProfile(userId, dto);
    }
}
