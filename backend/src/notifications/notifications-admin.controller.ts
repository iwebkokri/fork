import { BadRequestException, Body, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Throttle } from '@nestjs/throttler';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { AdminController, Permission } from '../common/decorators';
import { Action, Module, NotificationChannel, UserStatus, UserType } from '../common/enums';
import { User, WebPushSubscription } from '../database/entities';
import { SettingsService } from '../settings/settings.service';
import { CATEGORIES, EVENTS, defaultMatrix } from './events';
import { IsEmail } from 'class-validator';

class TestEmailDto {
  @IsEmail() to: string;
}
import { AdminTestDto, DeliveryLogQueryDto, SwitchesDto } from './notifications.dto';
import { NotificationsService } from './notifications.service';
import { FcmService } from './fcm.service';
import { audienceOfUser } from './preferences.service';
import { WebPushService } from './web-push.service';

/** System > Notifications: delivery log, push health, test sends, platform kill switches, event coverage. */
@AdminController('notifications')
export class NotificationsAdminController {
  constructor(
    private svc: NotificationsService,
    private push: WebPushService,
    private fcm: FcmService,
    private settings: SettingsService,
    private audit: AuditService,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(WebPushSubscription) private subs: Repository<WebPushSubscription>,
  ) {}

  private switches() {
    return {
      enabled: this.settings.get<boolean>('notifications.push.enabled', true) !== false,
      webEnabled: this.settings.get<boolean>('notifications.push.webEnabled', true) !== false,
      fcmEnabled: this.settings.get<boolean>('notifications.push.fcmEnabled', true) !== false,
    };
  }

  /** Push health + configuration (never returns a private key). */
  @Get('overview')
  @Permission(Module.NOTIFICATIONS, Action.VIEW)
  async overview() {
    let vapid: { configured: boolean; source?: string; publicKey?: string } = { configured: false };
    try {
      const k = await this.push.vapid();
      vapid = { configured: true, source: k.source, publicKey: k.publicKey };
    } catch {
      /* not available */
    }
    return {
      switches: this.switches(),
      vapid: { ...vapid, subject: this.push.subject() },
      fcm: { configured: this.fcm.configured(), apiBase: this.fcm.apiBase() },
      health: await this.push.health(),
      events: Object.keys(EVENTS).length,
    };
  }

  @Put('switches')
  @Permission(Module.NOTIFICATIONS, Action.EDIT)
  async setSwitches(@Body() dto: SwitchesDto, @Req() req: any) {
    const before = this.switches();
    if (dto.enabled !== undefined) await this.settings.set('notifications.push.enabled', dto.enabled);
    if (dto.webEnabled !== undefined) await this.settings.set('notifications.push.webEnabled', dto.webEnabled);
    if (dto.fcmEnabled !== undefined) await this.settings.set('notifications.push.fcmEnabled', dto.fcmEnabled);
    const after = this.switches();
    await this.audit.logReq(req, 'notifications.switches', 'setting', 'notifications.push', before, after);
    return after;
  }

  /** Delivery log of push / SMS / e-mail (the in-app inbox rows are not listed). */
  @Get('log')
  @Permission(Module.NOTIFICATIONS, Action.VIEW)
  log(@Query() q: DeliveryLogQueryDto) {
    const d = (s?: string) => {
      if (!s) return undefined;
      const x = new Date(s);
      return isNaN(x.getTime()) ? undefined : x;
    };
    return this.svc.deliveryLog({ ...q, page: q.page ? Number(q.page) : 1, limit: q.limit ? Number(q.limit) : 25, from: d(q.from), to: d(q.to) });
  }

  @Post('log/:id/retry')
  @HttpCode(200)
  @Permission(Module.NOTIFICATIONS, Action.EDIT)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async retry(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const r = await this.svc.retryDelivery(id);
    await this.audit.logReq(req, 'notifications.retry', 'notification', id, null, r);
    return r;
  }

  /** Which email provider is active (smtp or sendgrid, switched in Admin > System > Settings > notifications) and whether it is filled in. */
  @Get('email-status')
  @Permission(Module.NOTIFICATIONS, Action.VIEW)
  emailStatus() {
    return this.svc.emailStatus();
  }

  /** Sends one real email with the active provider and reports the exact result, so a wrong host / port / password shows up at once. */
  @Post('test-email')
  @HttpCode(200)
  @Permission(Module.NOTIFICATIONS, Action.EDIT)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async testEmail(@Body() dto: TestEmailDto, @Req() req: any) {
    const status = this.svc.emailStatus();
    if (!status.configured) return { ok: false, ...status, error: status.provider === 'sendgrid' ? 'The SendGrid API key is not filled in yet' : 'The SMTP server is not filled in yet (Amazon SES also uses the SMTP fields)' };
    try {
      await this.svc.sendEmail(dto.to, 'FORKSY test email', 'This is a test email from FORKSY. If you can read it, email (including sign-in codes) is working.');
      await this.audit.logReq(req, 'notifications.test_email', 'notification', undefined, null, { to: dto.to, provider: status.provider, ok: true });
      return { ok: true, ...status };
    } catch (e: any) {
      await this.audit.logReq(req, 'notifications.test_email', 'notification', undefined, null, { to: dto.to, provider: status.provider, ok: false });
      return { ok: false, ...status, error: String(e?.message ?? e).slice(0, 300) };
    }
  }

  /** Send a test push (+ in-app row) to one user, to every staff member of a role, or to every user of an app with a browser subscription. */
  @Post('test')
  @HttpCode(200)
  @Permission(Module.NOTIFICATIONS, Action.EDIT)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async test(@Body() dto: AdminTestDto, @Req() req: any) {
    const given = [dto.userId, dto.roleId, dto.app].filter(Boolean).length;
    if (given !== 1) throw new BadRequestException('Give exactly one of userId, roleId or app');
    let ids: string[] = [];
    if (dto.userId) ids = [dto.userId];
    else if (dto.roleId) ids = (await this.users.find({ where: { roleId: dto.roleId, status: UserStatus.ACTIVE }, select: ['id'], take: 200 })).map((u) => u.id);
    else {
      const rows = await this.subs.createQueryBuilder('s').select('DISTINCT s."userId"', 'userId').where('s.app = :app', { app: dto.app }).limit(200).getRawMany();
      ids = rows.map((r) => r.userId);
    }
    const message = (dto.message ?? '').trim() || 'This is a test push from FORKSY.';
    const out: { userId: string; push: string; error?: string | null }[] = [];
    for (const userId of ids) {
      const u = await this.users.findOne({ where: { id: userId } });
      if (!u) {
        out.push({ userId, push: 'NOT_FOUND' });
        continue;
      }
      const results = await this.svc.notifyDetailed({
        userId,
        audience: audienceOfUser(u.type as UserType),
        event: 'notification.test',
        vars: { message },
        channels: [NotificationChannel.PUSH, NotificationChannel.IN_APP],
        critical: true,
      });
      const p = results.find((r) => r.channel === NotificationChannel.PUSH);
      out.push({ userId, push: p?.status ?? 'SKIPPED', error: p?.error });
    }
    await this.audit.logReq(req, 'notifications.test', 'notification', undefined, null, { target: dto.userId ?? dto.roleId ?? dto.app, count: ids.length });
    return { targets: ids.length, sent: out.filter((o) => o.push === 'SENT').length, results: out };
  }

  /** Event x audience x channel coverage: the registry with the EFFECTIVE channels (matrix setting) - the editor is Notification Matrix. */
  @Get('coverage')
  @Permission(Module.NOTIFICATIONS, Action.VIEW)
  coverage() {
    const matrix = this.settings.get<Record<string, Record<string, string[]>>>('notifications.matrix', {});
    const defaults = defaultMatrix();
    const rows: any[] = [];
    for (const [event, def] of Object.entries(EVENTS)) {
      for (const [aud, a] of Object.entries(def.audiences)) {
        rows.push({
          event,
          audience: aud,
          category: def.category,
          channels: matrix[event]?.[aud] ?? defaults[event][aud],
          defaultChannels: defaults[event][aud],
          critical: !!a!.critical,
          urgency: a!.urgency ?? 'normal',
          requireInteraction: !!a!.requireInteraction,
          hasPushCopy: !!a!.push,
          neverPush: !!def.noPush,
          url: a!.url ?? null,
        });
      }
    }
    return { categories: CATEGORIES, rows };
  }
}
