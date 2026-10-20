import { BadRequestException, Body, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { AdminController, Permission, PublicController } from '../common/decorators';
import { Action, Module as Mod } from '../common/enums';
import { SettingsService } from '../settings/settings.service';
import { IntegrationsService } from './integrations.service';
import { GOOGLE_KEY_RE } from './google-maps.service';
import { BBOX_RE, COUNTRY_RE, MAPBOX_PUBLIC_TOKEN_RE, MAPBOX_STYLE_RE, MAPBOX_TOKEN_RE, PROXIMITY_RE, normalizeMapboxStyle } from './mapbox.service';
import { MapsService } from './maps.service';
import { StripeClientService, STRIPE_PUBLISHABLE_RE, STRIPE_SECRET_RE, STRIPE_WEBHOOK_RE } from './stripe-client.service';

const orEmpty = (re: RegExp) => new RegExp(`^(?:|${re.source.replace(/^\^/, '').replace(/\$$/, '')})$`);

/** Each secret: a value sets it, an empty string / null clears it, absent = unchanged. Formats are checked before anything is stored. */
export class UpdateStripeDto {
  @IsOptional() @IsString() @MaxLength(300) @Matches(orEmpty(STRIPE_SECRET_RE), { message: 'secretKey must look like sk_test_... / sk_live_... / rk_test_... / rk_live_...' }) secretKey?: string | null;
  @IsOptional() @IsString() @MaxLength(300) @Matches(orEmpty(STRIPE_PUBLISHABLE_RE), { message: 'publishableKey must look like pk_test_... / pk_live_...' }) publishableKey?: string | null;
  @IsOptional() @IsString() @MaxLength(300) @Matches(orEmpty(STRIPE_WEBHOOK_RE), { message: 'webhookSecret must look like whsec_...' }) webhookSecret?: string | null;
  @IsOptional() @Transform(({ obj }) => obj.connectEnabled) @IsBoolean() connectEnabled?: boolean;
  @IsOptional() @IsIn(['cad']) currency?: string;
  @IsOptional() @IsIn(['CA']) platformCountry?: string;
}

export class UpdateMapboxDto {
  @IsOptional() @IsString() @MaxLength(300) @Matches(orEmpty(MAPBOX_TOKEN_RE), { message: 'accessToken must look like sk.... or pk....' }) accessToken?: string | null;
  @IsOptional() @IsString() @MaxLength(300) @Matches(orEmpty(MAPBOX_PUBLIC_TOKEN_RE), { message: 'publicToken must look like pk....' }) publicToken?: string | null;
  /** `username/style_id`; the Style URL of Mapbox Studio (`mapbox://styles/username/style_id`) and the api.mapbox.com / studio.mapbox.com addresses of the style are accepted too and stored as `username/style_id` */
  @IsOptional() @Transform(({ value }) => normalizeMapboxStyle(value)) @IsString() @MaxLength(100) @Matches(orEmpty(MAPBOX_STYLE_RE), { message: 'style must look like username/style_id (e.g. mapbox/streets-v12) or the Style URL of Mapbox Studio (mapbox://styles/username/style_id)' }) style?: string;
  @IsOptional() @IsString() @MaxLength(60) @Matches(COUNTRY_RE, { message: 'country: ISO 3166 alpha-2 codes, comma separated, e.g. ca' }) country?: string;
  @IsOptional() @IsString() @MaxLength(80) @Matches(orEmpty(BBOX_RE), { message: 'bbox must be "minLng,minLat,maxLng,maxLat"' }) bbox?: string;
  @IsOptional() @IsString() @MaxLength(40) @Matches(orEmpty(PROXIMITY_RE), { message: 'proximity must be "lng,lat"' }) proximity?: string;
}

/** Google Maps keys: the server key does address search, routes and creates the tile session; the browser key (restrict it to your website addresses) is only used in the map tile URL. */
export class UpdateGoogleDto {
  @IsOptional() @IsString() @MaxLength(100) @Matches(orEmpty(GOOGLE_KEY_RE), { message: 'apiKey must look like AIza... (39 characters)' }) apiKey?: string | null;
  @IsOptional() @IsString() @MaxLength(100) @Matches(orEmpty(GOOGLE_KEY_RE), { message: 'browserKey must look like AIza... (39 characters)' }) browserKey?: string | null;
}

/** Which maps provider is in use, and whether real road distances / drive times are used for deliveries. */
export class UpdateMapsDto {
  @IsOptional() @IsIn(['mapbox', 'google']) provider?: string;
  @IsOptional() @Transform(({ obj }) => obj.roadDistances) @IsBoolean() roadDistances?: boolean;
}

/** System > Integrations: status of every key (never a secret), validated updates (Super Admin), test connection. */
@AdminController('integrations')
export class AdminIntegrationsController {
  constructor(private svc: IntegrationsService) {}

  @Get()
  @Permission(Mod.SETTINGS, Action.VIEW)
  status() {
    return this.svc.status();
  }

  @Put('stripe')
  @Permission(Mod.SETTINGS, Action.EDIT)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  updateStripe(@Body() dto: UpdateStripeDto, @Req() req: any) {
    return this.svc.updateStripe(dto, req);
  }

  @Put('mapbox')
  @Permission(Mod.SETTINGS, Action.EDIT)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  updateMapbox(@Body() dto: UpdateMapboxDto, @Req() req: any) {
    return this.svc.updateMapbox(dto, req);
  }

  @Put('google')
  @Permission(Mod.SETTINGS, Action.EDIT)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  updateGoogle(@Body() dto: UpdateGoogleDto, @Req() req: any) {
    return this.svc.updateGoogle(dto, req);
  }

  /** Switch the maps provider (Mapbox / Google) and the road-distance switch. Super Admin only; takes effect at once. */
  @Put('maps')
  @Permission(Mod.SETTINGS, Action.EDIT)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  updateMaps(@Body() dto: UpdateMapsDto, @Req() req: any) {
    return this.svc.updateMaps(dto, req);
  }

  @Post(':name/test')
  @Permission(Mod.SETTINGS, Action.EDIT)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  test(@Param('name') name: string, @Req() req: any) {
    return this.svc.test(name, req);
  }
}

// ------------------------------------------------------------------ geocoding (proxy to the active maps provider)
const SESSION_RE = /^[A-Za-z0-9-]{8,64}$/;
const ID_RE = /^[A-Za-z0-9_\-=.:+]{4,500}$/;

function cleanQuery(q: unknown): string {
  if (typeof q !== 'string') throw new BadRequestException('q is required');
  const s = q.normalize('NFC').replace(/[\u0000-\u001F\u007F-\u009F<>]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length < 3) throw new BadRequestException('Type at least 3 characters');
  if (s.length > 100) throw new BadRequestException('q is too long');
  return s;
}
const cleanProximity = (p: unknown): string | undefined => {
  if (p === undefined || p === '') return undefined;
  if (typeof p !== 'string' || !PROXIMITY_RE.test(p)) throw new BadRequestException('proximity must be "lng,lat"');
  const [lng, lat] = p.split(',').map(Number);
  if (Math.abs(lng) > 180 || Math.abs(lat) > 90) throw new BadRequestException('proximity is out of range');
  return p;
};
const cleanSession = (s: unknown): string => {
  if (typeof s !== 'string' || !SESSION_RE.test(s)) throw new BadRequestException('sessionToken must be 8-64 letters, digits or dashes (use a random UUID per search)');
  return s;
};
const cleanCoord = (v: unknown, name: string, max: number): number => {
  if (typeof v !== 'string' || !/^-?\d{1,3}(\.\d{1,10})?$/.test(v)) throw new BadRequestException(`${name} must be a number`);
  const n = Number(v);
  if (!Number.isFinite(n) || Math.abs(n) > max) throw new BadRequestException(`${name} is out of range`);
  return n;
};

/** Shared by the public and the admin routes. */
export class GeocodeHandlers {
  constructor(protected maps: MapsService) {}

  autocomplete(q: string, proximity: string | undefined, sessionToken: string) {
    return this.maps.autocomplete(cleanQuery(q), { proximity: cleanProximity(proximity), sessionToken: cleanSession(sessionToken) });
  }
  retrieve(id: string, sessionToken: string) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new BadRequestException('id is not valid');
    return this.maps.retrieve(id, cleanSession(sessionToken));
  }
  reverse(lat: string, lng: string) {
    return this.maps.reverse(cleanCoord(lat, 'lat', 90), cleanCoord(lng, 'lng', 180));
  }
}

/** No auth: the customer website / apps search addresses here. The provider key (Mapbox or Google) never leaves the server. { enabled:false } = fall back to manual entry. */
@PublicController('geocode')
export class PublicGeocodeController extends GeocodeHandlers {
  constructor(maps: MapsService) {
    super(maps);
  }

  @Get('autocomplete')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  override autocomplete(@Query('q') q: string, @Query('proximity') proximity?: string, @Query('sessionToken') sessionToken?: string) {
    return super.autocomplete(q, proximity, sessionToken as string);
  }

  @Get('retrieve')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  override retrieve(@Query('id') id: string, @Query('sessionToken') sessionToken?: string) {
    return super.retrieve(id, sessionToken as string);
  }

  @Get('reverse')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  override reverse(@Query('lat') lat: string, @Query('lng') lng: string) {
    return super.reverse(lat, lng);
  }
}

/** Same lookups for the Admin Console (restaurant location, zones...). Any signed-in staff member. */
@AdminController('geocode')
export class AdminGeocodeController extends GeocodeHandlers {
  constructor(maps: MapsService) {
    super(maps);
  }

  @Get('autocomplete')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  override autocomplete(@Query('q') q: string, @Query('proximity') proximity?: string, @Query('sessionToken') sessionToken?: string) {
    return super.autocomplete(q, proximity, sessionToken as string);
  }

  @Get('retrieve')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  override retrieve(@Query('id') id: string, @Query('sessionToken') sessionToken?: string) {
    return super.retrieve(id, sessionToken as string);
  }

  @Get('reverse')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  override reverse(@Query('lat') lat: string, @Query('lng') lng: string) {
    return super.reverse(lat, lng);
  }
}

/** The map the Admin Console draws: the active provider and its tile URL (public keys only) or the OpenStreetMap fallback. Any signed-in staff member. */
@AdminController('maps')
export class AdminMapsController {
  constructor(private maps: MapsService) {}

  @Get('config')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  config() {
    return this.maps.clientConfig();
  }
}

/** Public: how should the website pay? (publishable key only; never a secret) */
@PublicController('payments')
export class PublicPaymentsConfigController {
  constructor(private stripe: StripeClientService, private settings: SettingsService, private maps: MapsService) {}

  @Get('config')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  config() {
    const c = this.stripe.config();
    const provider = this.stripe.provider();
    return {
      provider, // stripe | mock | none
      mock: provider === 'mock',
      mode: provider === 'stripe' ? c.mode : 'none',
      publishableKey: provider === 'stripe' ? c.publishableKey || null : null,
      currency: c.currency,
      walletEnabled: this.settings.get<boolean>('payments.walletEnabled', true),
      giftCardsEnabled: this.settings.get<boolean>('payments.giftCardsEnabled', true),
      topUp: { min: Number(this.settings.get('payments.topUpMin', 5)), max: Number(this.settings.get('payments.topUpMax', 500)) },
      addressSearch: this.maps.enabled,
    };
  }
}
