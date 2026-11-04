import { Controller, Get, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { MARKET_RULES } from '@athosbet/shared';
import { AuthedRequest, AuthUser, CurrentUser, Public } from '../common/auth';
import { MatchFilter, SportsService } from './sports.service';
import { SyncService } from './sync.service';
import { err } from '../common/errors';

@ApiTags('sports')
@Controller()
export class SportsController {
  constructor(private readonly sports: SportsService, private readonly sync: SyncService) {}

  @Public()
  @Get('meta')
  meta() {
    return { dataProvider: this.sync.providerName, synthetic: this.sync.providerName === 'demo', realMoney: false, marketRules: MARKET_RULES };
  }

  @Public()
  @Get('competitions')
  competitions() {
    return this.sports.competitions();
  }

  @Public()
  @Get('matches')
  matches(@Req() req: AuthedRequest, @Query('filter') filter: MatchFilter = 'week', @Query('tz') tz = 'UTC', @Query('date') date?: string, @Query('competition') competition?: string, @Query('team') team?: string, @Query('favorites') fav?: string) {
    if (!['today', 'tomorrow', 'week', 'live', 'date'].includes(filter)) throw err.badRequest('INVALID_FILTER');
    if (fav === '1' && !req.user) throw err.unauthorized();
    return this.sports.listMatches({ filter, tz, date, competition, teamId: team, favoritesOf: fav === '1' ? req.user!.id : undefined });
  }

  @Public()
  @Get('matches/featured')
  featured() {
    return this.sports.featured();
  }

  @Public()
  @Get('matches/:id')
  match(@Param('id', ParseUUIDPipe) id: string) {
    return this.sports.match(id);
  }

  @Get('favorites')
  favorites(@CurrentUser() u: AuthUser) {
    return this.sports.favorites(u.id);
  }

  @Post('favorites/:kind/:id')
  toggle(@CurrentUser() u: AuthUser, @Param('kind') kind: string, @Param('id', ParseUUIDPipe) id: string) {
    const k = kind.toUpperCase();
    if (k !== 'TEAM' && k !== 'COMPETITION') throw err.badRequest('INVALID_KIND');
    return this.sports.toggleFavorite(u.id, k, id);
  }
}
