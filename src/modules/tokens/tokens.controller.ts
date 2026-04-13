import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { TokensService } from './tokens.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RedeemTokenDto } from './dto/redeem-token.dto';

@Controller('tokens')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TokensController {
  constructor(private readonly tokensService: TokensService) {}

  @Post('redeem')
  @Roles('PARTICIPANT')
  async redeemToken(@Body() dto: RedeemTokenDto, @CurrentUser() user: any) {
    return this.tokensService.redeemToken(dto.code, user.id);
  }
}
