import { BadRequestException, Body, ConflictException, Delete, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { City, DriverProfile, Restaurant, Zone } from '../database/entities';
import { AdminController, Permission, PublicController } from '../common/decorators';
import { Events } from '../common/contracts';
import { Action, Module as Mod } from '../common/enums';
import { countWaitlisted, countZoneDrivers } from '../drivers/zone-capacity';
import { PageQueryDto, paginateQb, like } from '../common/pagination';
import { pointInPolygon } from '../common/geo.util';
import { GeoService } from '../core/core.module';
import { AuditService } from '../audit/audit.service';
import { RealtimeService } from '../realtime/realtime.module';
import {
  BusyModeDto,
  CityQuery,
  CreateCityDto,
  CreateZoneDto,
  PublicResolveQuery,
  ResolveDto,
  ServiceHoursDto,
  UpdateCityDto,
  UpdateZoneDto,
  ZoneQuery,
} from './dto';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** Validates + normalises [[lat,lng],...]; throws 400 on garbage. */
export function cleanPolygon(poly: unknown): [number, number][] {
  if (!Array.isArray(poly) || poly.length < 3) throw new BadRequestException('polygon needs at least 3 [lat,lng] points');
  const out = poly.map((p, i) => {
    if (!Array.isArray(p) || p.length < 2 || typeof p[0] !== 'number' || typeof p[1] !== 'number') {
      throw new BadRequestException(`polygon[${i}] must be [lat, lng] numbers`);
    }
    if (Math.abs(p[0]) > 90 || Math.abs(p[1]) > 180) throw new BadRequestException(`polygon[${i}] out of range (order is [lat, lng])`);
    return [p[0], p[1]] as [number, number];
  });
  // drop explicit closing point (polygons are closed implicitly)
  const f = out[0];
  const l = out[out.length - 1];
  if (out.length > 3 && f[0] === l[0] && f[1] === l[1]) out.pop();
  return out;
}

export function centroid(poly: [number, number][]): { lat: number; lng: number } {
  const lat = poly.reduce((s, p) => s + p[0], 0) / poly.length;
  const lng = poly.reduce((s, p) => s + p[1], 0) / poly.length;
  return { lat: +lat.toFixed(6), lng: +lng.toFixed(6) };
}

function cleanHours(h: Record<string, { open: string; close: string; closed?: boolean }>) {
  const out: Record<string, { open: string; close: string; closed?: boolean }> = {};
  for (const [d, v] of Object.entries(h ?? {})) {
    if (!DAYS.includes(d)) throw new BadRequestException(`Unknown day "${d}" (use ${DAYS.join(',')})`);
    if (!v.closed && v.open >= v.close) throw new BadRequestException(`${d}: open must be before close`);
    out[d] = { open: v.open, close: v.close, ...(v.closed ? { closed: true } : {}) };
  }
  return out;
}

function assertTimezone(tz?: string) {
  if (!tz) return;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
  } catch {
    throw new BadRequestException(`Unknown IANA timezone: ${tz}`);
  }
}

@Injectable()
export class GeographyService {
  constructor(
    @InjectRepository(City) private cities: Repository<City>,
    @InjectRepository(Zone) private zones: Repository<Zone>,
    @InjectRepository(Restaurant) private restaurants: Repository<Restaurant>,
    @InjectRepository(DriverProfile) private drivers: Repository<DriverProfile>,
    private audit: AuditService,
    private rt: RealtimeService,
    private geo: GeoService,
    private events: EventEmitter2,
  ) {}

  // ------------------------------------------------------------ cities
  async listCities(q: CityQuery) {
    const qb = this.cities.createQueryBuilder('c');
    if (q.search) qb.andWhere('c.name ILIKE :s', { s: like(q.search) });
    if (q.active !== undefined) qb.andWhere('c.active = :a', { a: q.active === 'true' });
    const page = await paginateQb(qb, q, {
      sortable: { name: 'c.name', createdAt: 'c.createdAt', active: 'c.active' },
      defaultSort: ['c.name', 'ASC'],
    });
    const ids = page.data.map((c) => c.id);
    const zc = ids.length ? await this.zones.createQueryBuilder('z').select('z.cityId', 'cityId').addSelect('COUNT(*)', 'n').where('z.cityId IN (:...ids)', { ids }).groupBy('z.cityId').getRawMany() : [];
    const rc = ids.length ? await this.restaurants.createQueryBuilder('r').select('r.cityId', 'cityId').addSelect('COUNT(*)', 'n').where('r.cityId IN (:...ids)', { ids }).groupBy('r.cityId').getRawMany() : [];
    const zm = new Map(zc.map((r) => [r.cityId, +r.n]));
    const rm = new Map(rc.map((r) => [r.cityId, +r.n]));
    return { ...page, data: page.data.map((c) => ({ ...c, zoneCount: zm.get(c.id) ?? 0, restaurantCount: rm.get(c.id) ?? 0 })) };
  }

  async getCity(id: string) {
    const c = await this.cities.findOne({ where: { id } });
    if (!c) throw new NotFoundException('City not found');
    const zones = await this.zones.find({ where: { cityId: id }, order: { name: 'ASC' } });
    return { ...c, zones: zones.map((z) => ({ id: z.id, name: z.name, active: z.active, busyMode: z.busyMode })) };
  }

  async createCity(dto: CreateCityDto, req: any) {
    assertTimezone(dto.timezone);
    if (await this.cities.findOne({ where: { name: dto.name } })) throw new ConflictException('A city with this name exists');
    const city = await this.cities.save(this.cities.create(dto));
    await this.audit.logReq(req, 'city.create', 'city', city.id, undefined, city);
    return city;
  }

  async updateCity(id: string, dto: UpdateCityDto, req: any) {
    assertTimezone(dto.timezone);
    const city = await this.cities.findOne({ where: { id } });
    if (!city) throw new NotFoundException('City not found');
    if (dto.name && dto.name !== city.name && (await this.cities.findOne({ where: { name: dto.name } }))) throw new ConflictException('A city with this name exists');
    const before = { ...city };
    Object.assign(city, dto);
    const saved = await this.cities.save(city);
    await this.audit.logReq(req, 'city.update', 'city', id, diff(before, dto), diff(saved, dto));
    this.rt.emitToOps('city.updated', { id });
    return saved;
  }

  async deleteCity(id: string, req: any) {
    const city = await this.cities.findOne({ where: { id } });
    if (!city) throw new NotFoundException('City not found');
    const [z, r, d] = await Promise.all([this.zones.count({ where: { cityId: id } }), this.restaurants.count({ where: { cityId: id } }), this.drivers.count({ where: { cityId: id } })]);
    if (z || r || d) throw new ConflictException(`City is in use (${z} zones, ${r} restaurants, ${d} drivers). Deactivate it instead.`);
    await this.cities.delete(id);
    await this.audit.logReq(req, 'city.delete', 'city', id, city);
    return { deleted: true };
  }

  // ------------------------------------------------------------ zones
  async listZones(q: ZoneQuery) {
    const qb = this.zones.createQueryBuilder('z').leftJoinAndSelect('z.city', 'city');
    if (q.cityId) qb.andWhere('z.cityId = :c', { c: q.cityId });
    if (q.search) qb.andWhere('z.name ILIKE :s', { s: like(q.search) });
    if (q.active !== undefined) qb.andWhere('z.active = :a', { a: q.active === 'true' });
    if (q.busy !== undefined) qb.andWhere('z.busyMode = :b', { b: q.busy === 'true' });
    const page = await paginateQb(qb, q, { sortable: { name: 'z.name', createdAt: 'z.createdAt', targetDrivers: 'z.targetDrivers' }, defaultSort: ['z.name', 'ASC'] });
    const ids = page.data.map((z) => z.id);
    const rc = ids.length ? await this.restaurants.createQueryBuilder('r').select('r.zoneId', 'zoneId').addSelect('COUNT(*)', 'n').where('r.zoneId IN (:...ids)', { ids }).groupBy('r.zoneId').getRawMany() : [];
    const rm = new Map(rc.map((r) => [r.zoneId, +r.n]));
    return {
      ...page,
      data: await Promise.all(
        page.data.map(async (z) => ({
          ...z,
          city: z.city ? { id: z.city.id, name: z.city.name } : null,
          restaurantCount: rm.get(z.id) ?? 0,
          effective: this.geo.effective(z, z.city),
          // how full the zone is: drivers holding a place, and couriers waiting for one
          driverCount: await countZoneDrivers(this.drivers, z.id),
          waitlistCount: await countWaitlisted(this.drivers, z.id),
        })),
      ),
    };
  }

  async getZone(id: string) {
    const z = await this.zones.findOne({ where: { id }, relations: { city: true } });
    if (!z) throw new NotFoundException('Zone not found');
    const [restaurantCount, onlineDrivers] = await Promise.all([
      this.restaurants.count({ where: { zoneId: id } }),
      this.drivers.count({ where: { activeZoneId: id, isOnline: true } }),
    ]);
    return { ...z, restaurantCount, onlineDrivers, effective: this.geo.effective(z, z.city) };
  }

  async createZone(dto: CreateZoneDto, req: any) {
    const city = await this.cities.findOne({ where: { id: dto.cityId } });
    if (!city) throw new BadRequestException('Unknown cityId');
    const polygon = dto.polygon ? cleanPolygon(dto.polygon) : [];
    const c = polygon.length ? centroid(polygon) : { lat: dto.centerLat ?? city.centerLat, lng: dto.centerLng ?? city.centerLng };
    const { polygon: _p, centerLat: _a, centerLng: _b, serviceHours, ...rest } = dto;
    const zone = await this.zones.save(
      this.zones.create({ ...rest, polygon, centerLat: dto.centerLat ?? c.lat, centerLng: dto.centerLng ?? c.lng, serviceHours: serviceHours ? cleanHours(serviceHours) : {} }),
    );
    await this.audit.logReq(req, 'zone.create', 'zone', zone.id, undefined, { ...zone, polygon: `${polygon.length} points` });
    this.rt.emitToOps('zone.updated', { id: zone.id });
    return zone;
  }

  async updateZone(id: string, dto: UpdateZoneDto, req: any) {
    const zone = await this.zones.findOne({ where: { id } });
    if (!zone) throw new NotFoundException('Zone not found');
    if (dto.cityId && !(await this.cities.findOne({ where: { id: dto.cityId } }))) throw new BadRequestException('Unknown cityId');
    const before = { ...zone, polygon: `${zone.polygon?.length ?? 0} points` };
    const { polygon, serviceHours, ...rest } = dto;
    Object.assign(zone, rest);
    if (polygon) {
      zone.polygon = cleanPolygon(polygon);
      if (dto.centerLat === undefined && dto.centerLng === undefined) {
        const c = centroid(zone.polygon);
        zone.centerLat = c.lat;
        zone.centerLng = c.lng;
      }
    }
    if (serviceHours) zone.serviceHours = cleanHours(serviceHours);
    const saved = await this.zones.save(zone);
    await this.audit.logReq(req, 'zone.update', 'zone', id, before, { ...saved, polygon: `${saved.polygon?.length ?? 0} points` });
    this.rt.emitToOps('zone.updated', { id });
    // a new driver limit means places may have opened: couriers waiting for this zone are invited
    if (dto.driverCapacity !== undefined && (before as any).driverCapacity !== saved.driverCapacity) this.events.emit(Events.ZONE_CAPACITY_CHANGED, { zoneId: id });
    return saved;
  }

  async setServiceHours(id: string, dto: ServiceHoursDto, req: any) {
    const zone = await this.zones.findOne({ where: { id } });
    if (!zone) throw new NotFoundException('Zone not found');
    const before = zone.serviceHours;
    zone.serviceHours = cleanHours(dto.serviceHours);
    await this.zones.save(zone);
    await this.audit.logReq(req, 'zone.service_hours', 'zone', id, before, zone.serviceHours);
    return zone;
  }

  /** SOP-04 step 4: busy-mode fees / radius limits per zone playbook. */
  async setBusyMode(id: string, dto: BusyModeDto, req: any) {
    const zone = await this.zones.findOne({ where: { id }, relations: { city: true } });
    if (!zone) throw new NotFoundException('Zone not found');
    const before = { busyMode: zone.busyMode, busyMultiplier: zone.busyMultiplier, busyRadiusKm: zone.busyRadiusKm };
    zone.busyMode = dto.enabled;
    if (dto.multiplier !== undefined) zone.busyMultiplier = dto.multiplier;
    else if (dto.enabled && zone.busyMultiplier <= 1) zone.busyMultiplier = zone.city?.busyMultiplier > 1 ? zone.city.busyMultiplier : 1.25;
    if (dto.radiusKm !== undefined) zone.busyRadiusKm = dto.radiusKm;
    await this.zones.save(zone);
    const after = { busyMode: zone.busyMode, busyMultiplier: zone.busyMultiplier, busyRadiusKm: zone.busyRadiusKm, reason: dto.reason };
    await this.audit.logReq(req, dto.enabled ? 'zone.busy_on' : 'zone.busy_off', 'zone', id, before, after);
    const payload = { zoneId: id, name: zone.name, ...after };
    this.rt.emitToZone(id, 'zone.busy', payload);
    this.rt.emitToOps('zone.busy', payload);
    return zone;
  }

  async deleteZone(id: string, req: any) {
    const zone = await this.zones.findOne({ where: { id } });
    if (!zone) throw new NotFoundException('Zone not found');
    const r = await this.restaurants.count({ where: { zoneId: id } });
    if (r) throw new ConflictException(`Zone has ${r} restaurants. Move them or deactivate the zone instead.`);
    await this.zones.delete(id);
    await this.audit.logReq(req, 'zone.delete', 'zone', id, { ...zone, polygon: `${zone.polygon?.length ?? 0} points` });
    return { deleted: true };
  }

  /** Which zone/city serves a coordinate + effective fees (used by admin tools and the public API). */
  async resolve(lat: number, lng: number) {
    const zone = await this.geo.resolveZone(lat, lng);
    const city = await this.geo.cityFor(zone);
    const insidePolygon = !!zone && pointInPolygon(lat, lng, zone.polygon);
    return { serviceable: !!zone && !!city?.active && zone.active, insidePolygon, zone, city, effective: zone ? this.geo.effective(zone, city) : null };
  }

  async publicResolve(lat: number, lng: number) {
    const r = await this.resolve(lat, lng);
    return {
      serviceable: r.serviceable,
      zone: r.zone ? { id: r.zone.id, name: r.zone.name, cityId: r.zone.cityId, busyMode: r.zone.busyMode, serviceHours: r.zone.serviceHours } : null,
      city: r.city ? { id: r.city.id, name: r.city.name, timezone: r.city.timezone, currency: r.city.currency } : null,
      fees: r.effective ? { baseFee: r.effective.baseFee, perKmFee: r.effective.perKmFee, minimumOrder: r.effective.minimumOrder, busyMultiplier: r.effective.busyMultiplier } : null,
    };
  }

  async publicCities() {
    const cities = await this.cities.find({ where: { active: true }, order: { name: 'ASC' } });
    const zones = await this.zones.find({ where: { active: true }, order: { name: 'ASC' } });
    return cities.map((c) => ({
      id: c.id,
      name: c.name,
      province: c.province,
      country: c.country,
      timezone: c.timezone,
      currency: c.currency,
      centerLat: c.centerLat,
      centerLng: c.centerLng,
      zones: zones
        .filter((z) => z.cityId === c.id)
        .map((z) => ({ id: z.id, name: z.name, centerLat: z.centerLat, centerLng: z.centerLng, polygon: z.polygon, busyMode: z.busyMode, serviceHours: z.serviceHours })),
    }));
  }
}

/** Only the keys touched by the dto (keeps audit rows small). */
function diff(obj: any, dto: object) {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(dto)) out[k] = obj[k];
  return out;
}

@AdminController('cities')
export class CitiesController {
  constructor(private svc: GeographyService) {}
  @Get() @Permission(Mod.ZONES, Action.VIEW) list(@Query() q: CityQuery) {
    return this.svc.listCities(q);
  }
  @Get(':id') @Permission(Mod.ZONES, Action.VIEW) get(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.getCity(id);
  }
  @Post() @Permission(Mod.ZONES, Action.CREATE) create(@Body() dto: CreateCityDto, @Req() req: any) {
    return this.svc.createCity(dto, req);
  }
  @Patch(':id') @Permission(Mod.ZONES, Action.EDIT) update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCityDto, @Req() req: any) {
    return this.svc.updateCity(id, dto, req);
  }
  @Delete(':id') @Permission(Mod.ZONES, Action.DELETE) remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.svc.deleteCity(id, req);
  }
}

@AdminController('zones')
export class ZonesController {
  constructor(private svc: GeographyService) {}
  @Get() @Permission(Mod.ZONES, Action.VIEW) list(@Query() q: ZoneQuery) {
    return this.svc.listZones(q);
  }
  @Post('resolve') @Permission(Mod.ZONES, Action.VIEW) resolve(@Body() dto: ResolveDto) {
    return this.svc.resolve(dto.lat, dto.lng);
  }
  @Get(':id') @Permission(Mod.ZONES, Action.VIEW) get(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.getZone(id);
  }
  @Post() @Permission(Mod.ZONES, Action.CREATE) create(@Body() dto: CreateZoneDto, @Req() req: any) {
    return this.svc.createZone(dto, req);
  }
  @Patch(':id') @Permission(Mod.ZONES, Action.EDIT) update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateZoneDto, @Req() req: any) {
    return this.svc.updateZone(id, dto, req);
  }
  @Put(':id/service-hours') @Permission(Mod.ZONES, Action.EDIT) hours(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ServiceHoursDto, @Req() req: any) {
    return this.svc.setServiceHours(id, dto, req);
  }
  @Post(':id/busy-mode') @Permission(Mod.ZONES, Action.EDIT) busy(@Param('id', ParseUUIDPipe) id: string, @Body() dto: BusyModeDto, @Req() req: any) {
    return this.svc.setBusyMode(id, dto, req);
  }
  @Delete(':id') @Permission(Mod.ZONES, Action.DELETE) remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.svc.deleteZone(id, req);
  }
}

@PublicController()
export class PublicGeoController {
  constructor(private svc: GeographyService) {}
  @Get('cities') cities() {
    return this.svc.publicCities();
  }
  @Get('zones/resolve') resolve(@Query() q: PublicResolveQuery) {
    return this.svc.publicResolve(q.lat, q.lng);
  }
}

export { PageQueryDto };
