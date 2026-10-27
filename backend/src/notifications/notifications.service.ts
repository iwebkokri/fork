import * as nodemailer from 'nodemailer';
import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { CustomerProfile, DeviceToken, Notification, NotificationTemplate, RestaurantMember, User } from '../database/entities';
import { NotificationChannel, UserStatus, UserType } from '../common/enums';
import { SettingsService } from '../settings/settings.service';
import { RealtimeService } from '../realtime/realtime.module';
import {
  Audience,
  AudienceDef,
  BASE_URL,
  CATEGORY_KEYS,
  EVENTS,
  EventDef,
  LOCKED_IN_APP,
  PUSH_BODY_MAX,
  PUSH_TITLE_MAX,
  URGENCY_TTL,
  Urgency,
  audienceDef,
  categoryOf,
  clip,
  defaultMatrix,
  eventDef,
  fillTemplate,
  inQuietHours,
  pickAllowed,
  scrubPush,
  urlFor,
} from './events';
import { FcmService } from './fcm.service';
import { PreferencesService, audienceOfUser } from './preferences.service';
import { PushPayload, PushResult, WebPushService } from './web-push.service';

export type { Audience } from './events';
export interface NotifyInput {
  userId: string;
  audience: Audience;
  event: string;
  vars?: Record<string, any>;
  data?: Record<string, any>;
  /** override channels from the notification matrix */
  channels?: NotificationChannel[];
  /** marketing messages honour CASL opt-in */
  marketing?: boolean;
  /** critical alerts ignore quiet hours (tests, safety) */
  critical?: boolean;
  /** literal message (skips templates) */
  title?: string;
  body?: string;
}

/** Built-in message copy. Copied into notification_templates on first boot so admins can edit it. */
const BASE_MESSAGES: Record<string, Partial<Record<Audience, { title: string; body: string }>>> = {
  'order.placed': {
    CUSTOMER: { title: 'Order placed', body: 'Thanks! Your order {{code}} from {{restaurant}} was placed. Total {{total}}. {{cancelNote}}' },
    RESTAURANT: { title: 'New order {{code}}', body: 'New {{type}} order {{code}} - {{itemCount}} items, {{total}}. Accept it within {{acceptMinutes}} min.' },
  },
  'order.accepted': { CUSTOMER: { title: 'Order accepted', body: '{{restaurant}} accepted your order {{code}}. Ready in about {{prepMinutes}} min.' } },
  'order.rejected': { CUSTOMER: { title: 'Order declined', body: '{{restaurant}} could not take order {{code}} ({{reason}}). Your payment is refunded in full.' } },
  'driver.offer': { DRIVER: { title: 'New delivery offer', body: '{{restaurant}} - {{pickupKm}} km to pickup, {{dropKm}} km to drop-off. Est. pay {{pay}}. Respond in {{seconds}}s.' } },
  'driver.assigned': {
    CUSTOMER: { title: 'Driver on the way to the restaurant', body: '{{driverName}} ({{vehicle}}) will pick up your order {{code}}.' },
    RESTAURANT: { title: 'Driver assigned', body: '{{driverName}} is arriving in about {{etaMinutes}} min for order {{code}}.' },
  },
  'order.ready': {
    CUSTOMER: { title: 'Your order is ready', body: 'Order {{code}} is ready. {{pickupHint}}' },
    DRIVER: { title: 'Order ready for pickup', body: 'Order {{code}} is ready at {{restaurant}}. Tell the staff your order number {{code}}, then mark it picked up in the app.' },
  },
  'order.picked_up': { CUSTOMER: { title: 'Order picked up', body: '{{driverName}} picked up order {{code}} and is heading your way.' } },
  'order.delivered': {
    CUSTOMER: { title: 'Delivered - enjoy!', body: 'Order {{code}} was delivered. Rate your experience in the app.' },
    DRIVER: { title: 'Trip complete', body: 'You earned {{earnings}} for order {{code}}.' },
    RESTAURANT: { title: 'Order {{code}} completed', body: 'Order {{code}} was handed off. Ticket closed.' },
  },
  // ---- ratings (docs/ratings.md) ----
  'rating.prompt': { CUSTOMER: { title: 'How was your order?', body: 'Tell us about order {{code}} from {{restaurant}}. It takes 10 seconds.' } },
  'rating.reminder': { CUSTOMER: { title: 'Still thinking about {{restaurant}}?', body: 'Rate order {{code}} before {{closesOn}} - your feedback helps other customers.' } },
  'rating.prompt_partner': {
    DRIVER: { title: 'Rate your delivery', body: 'How was the handoff for order {{code}}? Your feedback about the customer is private.' },
    RESTAURANT: { title: 'Rate the customer', body: 'Anything to share about order {{code}}? Your feedback about the customer is private.' },
  },
  'rating.driver_warn': {
    DRIVER: { title: 'Your rating needs attention', body: 'Your rating over the last 30 days is {{rating}} ({{count}} ratings). {{coaching}}' },
    ADMIN: { title: 'Driver rating below target', body: '{{subject}} is at {{rating}} over {{count}} ratings in 30 days (target {{threshold}}).' },
  },
  'rating.restaurant_warn': {
    RESTAURANT: { title: 'Your rating needs attention', body: '{{subject}} is rated {{rating}} over the last 30 days ({{count}} ratings). {{coaching}}' },
    ADMIN: { title: 'Restaurant rating below target', body: '{{subject}} is at {{rating}} over {{count}} ratings in 30 days (target {{threshold}}).' },
  },
  'rating.customer_safety': { ADMIN: { title: 'Customer safety flag', body: 'A {{raterType}} reported {{tags}} for customer {{customer}} (order {{code}}). Review the profile.' } },
  'review.flagged': { ADMIN: { title: 'Review flagged', body: 'A review for {{subject}} was held back from public ratings: {{reasons}}.' } },
  'review.reported': { ADMIN: { title: 'Review reported by a restaurant', body: '{{subject}} reported a review as abusive: {{reason}}' } },
  'incident.opened': { ADMIN: { title: '{{severity}} incident: {{title}}', body: 'Incident opened ({{severity}}): {{title}}. Update stakeholders every 30 min (SOP-10).' } },
  'incident.resolved': { ADMIN: { title: 'Incident resolved: {{title}}', body: 'Post-incident report due by {{reportDueAt}}.' } },
  'order.late': {
    CUSTOMER: { title: 'Your order is running late', body: 'New ETA for order {{code}}: {{eta}}. Sorry for the wait.' },
    RESTAURANT: { title: 'Order {{code}} is late', body: 'Order {{code}} is past its promised time.' },
    DRIVER: { title: 'Order {{code}} is late', body: 'Please pick up / deliver order {{code}} as soon as possible.' },
    ADMIN: { title: 'Late order {{code}}', body: 'Order {{code}} is late ({{reason}}).' },
  },
  'order.no_driver': {
    CUSTOMER: { title: 'Small delay finding a driver', body: 'We are still looking for a driver for order {{code}}.' },
    RESTAURANT: { title: 'No driver yet for {{code}}', body: 'We are still looking for a driver for order {{code}}.' },
    ADMIN: { title: 'No driver found: {{code}}', body: 'Order {{code}} has no driver after escalation - assign manually.' },
  },
  'order.cancelled': {
    CUSTOMER: { title: 'Order cancelled', body: 'Order {{code}} was cancelled. {{refundNote}}' },
    RESTAURANT: { title: 'Order {{code}} cancelled', body: 'Order {{code}} was cancelled ({{reason}}).' },
    DRIVER: { title: 'Order {{code}} cancelled', body: 'Order {{code}} was cancelled. You will be compensated where applicable.' },
  },
  'document.expiring': {
    RESTAURANT: { title: 'Document expiring', body: 'Your {{docType}} expires on {{expiresAt}}. Upload a new one to stay live.' },
    DRIVER: { title: 'Document expiring', body: 'Your {{docType}} expires on {{expiresAt}}. Upload a renewed copy to keep driving.' },
    ADMIN: { title: 'Document expiring', body: '{{subject}} - {{docType}} expires {{expiresAt}}.' },
  },
  'finance.batch_draft': { ADMIN: { title: 'Payout batch ready', body: 'Draft payout batch for {{period}} was created. Lock, reconcile and approve it (SOP-07).' } },
  'finance.payout_failed': { ADMIN: { title: 'Payout failed', body: 'Payout to {{party}} ({{amount}}) failed: {{reason}}' } },
  'finance.refund_pending': { ADMIN: { title: 'Refund awaiting approval', body: 'Refund of {{amount}} on order {{code}} needs approval.' } },
  'finance.payout_waiting_account': { ADMIN: { title: 'Payout waiting for a payout account', body: '{{party}} has money waiting but has not finished the Stripe payout account setup. It is sent automatically once the account is ready.' } },
  'finance.dispute': { ADMIN: { title: 'Card dispute (chargeback)', body: 'Dispute {{status}} on order {{code}}: {{amount}} ({{reason}}). Respond before {{dueBy}} in the Stripe dashboard.' } },
  'finance.stripe_alert': { ADMIN: { title: 'Stripe payment alert', body: '{{message}}' } },
  'payout.account_not_ready': {
    RESTAURANT: { title: 'Finish your payout account', body: 'You have money waiting to be paid out. Complete your Stripe payout account setup (Finance > Payout account) and we send it automatically.' },
    DRIVER: { title: 'Finish your payout account', body: 'You have earnings waiting. Complete your Stripe payout account setup (Earnings > Payout account) and we send them automatically.' },
  },
  'payout.bank_failed': {
    RESTAURANT: { title: 'Payout could not reach your bank', body: 'Stripe could not deposit a payout to your bank account: {{reason}}. Please check your bank details in your payout account.' },
    DRIVER: { title: 'Payout could not reach your bank', body: 'Stripe could not deposit a payout to your bank or card: {{reason}}. Please check your details in your payout account.' },
  },
  'payout.sent': {
    RESTAURANT: { title: 'Payout sent', body: 'Your payout of {{amount}} for {{period}} has been sent.' },
    DRIVER: { title: 'Payout sent', body: 'Your payout of {{amount}} has been sent.' },
  },
  'account.approved': {
    RESTAURANT: { title: 'You are live on FORKSY', body: '{{name}} is now live. Welcome aboard!' },
    DRIVER: { title: 'You are approved!', body: 'Welcome to FORKSY. You can go online in your approved zones.' },
  },
  'account.rejected': {
    RESTAURANT: { title: 'Application update', body: 'We could not approve {{name}}: {{reason}}' },
    DRIVER: { title: 'Application update', body: 'We could not approve your application: {{reason}}' },
  },
  'account.deactivation_notice': {
    DRIVER: { title: 'Account review notice', body: 'Your account is under review ({{reason}}). Please respond by {{respondBy}}.' },
    RESTAURANT: { title: 'Account review notice', body: 'Your store is under review ({{reason}}). Please respond by {{respondBy}}.' },
  },
  'order.item_removed': { CUSTOMER: { title: 'An item is unavailable', body: '{{restaurant}} could not make "{{item}}" for order {{code}}. Approve the change to get {{amount}} back, or cancel the order.' } },
  'order.partial_refund': { CUSTOMER: { title: 'Order updated', body: 'Order {{code}} was updated and {{amount}} will be refunded.' } },
  'order.tip_updated': { DRIVER: { title: 'Tip updated', body: 'The tip for order {{code}} is now {{tip}}.' } },
  'menu.access_requested': { ADMIN: { title: 'Menu editing requested: {{name}}', body: '{{name}} asked to be allowed to edit its own menu. {{note}}' } },
  'assistant.training.requested': { ADMIN: { title: 'Bot training approval: {{name}}', body: '{{name}} asks to publish its trained assistant ({{entries}} answers). Review it in Assistant > Training.' } },
  'assistant.training.decided': { RESTAURANT: { title: 'Your assistant training was {{decision}}', body: 'FORKSY has {{decision}} the change to your assistant. {{note}}' } },
  'menu.access_decided': { RESTAURANT: { title: 'Menu editing {{decision}}', body: 'FORKSY has {{decision}} menu editing for {{name}}. {{note}}' } },
  'order.cancel_requested': { RESTAURANT: { title: 'Cancellation request: order {{code}}', body: 'FORKSY support asks to cancel order {{code}}: {{reason}}. Please approve or decline in your portal.' } },
  'order.cancel_request_answered': { ADMIN: { title: 'Cancellation request {{decision}}: {{code}}', body: 'The restaurant {{decision}} the cancellation of order {{code}}. {{note}}' } },
  'driver.waiting': { RESTAURANT: { title: 'Driver is waiting: order {{code}}', body: 'The driver for order {{code}} is waiting. Hand the order over now: wait charges of {{perMinute}} per minute start {{startsIn}}.' } },
  'wait.fee_charged': { RESTAURANT: { title: 'Driver wait charge: order {{code}}', body: 'The driver waited {{minutes}} min for order {{code}}. {{amount}} is deducted from your payout (driver wait-time pay).' }, DRIVER: { title: 'Wait-time pay: order {{code}}', body: 'You earned {{amount}} for waiting {{minutes}} min at the restaurant for order {{code}}.' } },
  'order.stuck': { ADMIN: { title: 'Order {{code}} needs attention', body: 'Order {{code}}: {{reason}}' } },
  'refund.pending_approval': { ADMIN: { title: 'Refund needs approval', body: 'A refund of {{amount}} on order {{code}} is waiting for approval ({{reason}}).' } },
  'refund.rejected': { CUSTOMER: { title: 'Refund request update', body: 'Your refund request for order {{code}} was not approved.' } },
  'payment.failed': { ADMIN: { title: 'Payment problem', body: 'Order {{code}}: {{reason}}' } },
  'refund.issued': { CUSTOMER: { title: 'Refund issued', body: 'We refunded {{amount}} for order {{code}}.' } },
  'credit.issued': { CUSTOMER: { title: 'FORKSY credit added', body: '{{amount}} of credit was added to your wallet.' } },
  'promo.pending': { ADMIN: { title: 'Promotion awaiting approval', body: '{{restaurant}} submitted "{{name}}" for approval.' } },
  'promo.approved': { RESTAURANT: { title: 'Promotion approved', body: 'Your promotion "{{name}}" was approved and is now live.' } },
  'promo.rejected': { RESTAURANT: { title: 'Promotion not approved', body: 'Your promotion "{{name}}" was not approved: {{reason}}' } },
  'campaign.message': { CUSTOMER: { title: '{{title}}', body: '{{body}}' }, DRIVER: { title: '{{title}}', body: '{{body}}' }, RESTAURANT: { title: '{{title}}', body: '{{body}}' } },
  'ticket.update': { CUSTOMER: { title: 'Support update', body: 'There is an update on ticket {{number}}.' } },
  'sos.alert': { ADMIN: { title: 'SOS from driver', body: 'Driver {{driverName}} triggered the safety button.' } },
  'supply.alert': { DRIVER: { title: 'Busy in {{zone}}', body: 'Demand is high in {{zone}}. Go online for a {{boost}} boost.' } },
  'otp.code': {
    CUSTOMER: { title: 'Your FORKSY code', body: 'Your FORKSY verification code is {{code}}. It expires in {{minutes}} minutes.' },
    DRIVER: { title: 'Your FORKSY code', body: 'Your FORKSY verification code is {{code}}. It expires in {{minutes}} minutes.' },
    RESTAURANT: { title: 'Your FORKSY code', body: 'Your FORKSY verification code is {{code}}. It expires in {{minutes}} minutes.' },
    ADMIN: { title: 'Your FORKSY code', body: 'Your FORKSY verification code is {{code}}. It expires in {{minutes}} minutes.' },
  },
};

/** Built-in copy: the long-standing messages above plus the copy of every event that only the registry (events.ts) declares. */
export const DEFAULT_MESSAGES: Record<string, Partial<Record<Audience, { title: string; body: string }>>> = (() => {
  const out: Record<string, Partial<Record<Audience, { title: string; body: string }>>> = {};
  for (const [k, v] of Object.entries(BASE_MESSAGES)) out[k] = { ...v };
  for (const [k, d] of Object.entries(EVENTS)) if (d.msg) out[k] = { ...(d.msg as any), ...(out[k] ?? {}) };
  return out;
})();

export function renderTemplate(tpl: string, vars: Record<string, any> = {}): string {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, k) => {
    const v = k.split('.').reduce((o: any, p: string) => (o == null ? o : o[p]), vars);
    return v === undefined || v === null ? '' : String(v);
  });
}

export interface ChannelOutcome {
  channel: NotificationChannel;
  status: 'SENT' | 'FAILED' | 'SKIPPED';
  error?: string | null;
  id?: string;
  sent?: number;
  failed?: number;
  removed?: number;
}

export interface InboxQuery {
  cursor?: string;
  limit?: number;
  unread?: boolean;
  category?: string;
  page?: number;
}

const encodeCursor = (d: Date, id: string) => Buffer.from(`${d.toISOString()}|${id}`).toString('base64url');
function decodeCursor(c?: string): { at: Date; id: string } | null {
  if (!c) return null;
  try {
    const [iso, id] = Buffer.from(c, 'base64url').toString('utf8').split('|');
    const at = new Date(iso);
    if (isNaN(at.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    return { at, id };
  } catch {
    return null;
  }
}

/** changes whenever the registry / built-in copy grows, so new events are topped up into existing databases once */
const templateSeedVersion = () => Object.keys(EVENTS).length * 1000 + Object.values(DEFAULT_MESSAGES).reduce((n, m) => n + Object.keys(m).length, 0);

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private config: ConfigService,
    private settings: SettingsService,
    private rt: RealtimeService,
    @InjectRepository(Notification) private repo: Repository<Notification>,
    @InjectRepository(NotificationTemplate) private templates: Repository<NotificationTemplate>,
    @InjectRepository(DeviceToken) private tokens: Repository<DeviceToken>,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(CustomerProfile) private customers: Repository<CustomerProfile>,
    @InjectRepository(RestaurantMember) private members: Repository<RestaurantMember>,
    private webpush: WebPushService,
    private fcm: FcmService,
    private prefs: PreferencesService,
  ) {}

  async onModuleInit() {
    try {
      await this.settings.ensureDefaults();
      await this.settings.reload();
      await this.syncDefaults();
    } catch (e: any) {
      this.logger.warn(`notification defaults sync skipped: ${e.message}`);
    }
    // generate / load the VAPID keys at boot so the first browser to ask never waits for key generation
    this.webpush.vapid().catch((e) => this.logger.error(`VAPID init failed: ${e.message}`));
  }

  /**
   * Top up (never overwrite) the platform defaults: the notifications.matrix setting gets every event / audience of the registry that
   * it does not have yet, and notification_templates gets the missing template rows. Admin edits are kept. Runs once per version.
   */
  async syncDefaults() {
    const matrix = { ...(this.settings.get<Record<string, Record<string, string[]>>>('notifications.matrix', {}) ?? {}) };
    let changed = false;
    for (const [event, byAud] of Object.entries(defaultMatrix())) {
      for (const [aud, channels] of Object.entries(byAud)) {
        if (!matrix[event]) matrix[event] = {};
        if (!matrix[event][aud]) {
          matrix[event][aud] = channels;
          changed = true;
        }
      }
    }
    if (changed) await this.settings.set('notifications.matrix', matrix);

    const seeded = Number(this.settings.get<number>('notifications.templateSeedVersion', 0));
    if (seeded === templateSeedVersion()) return;
    const existing = await this.templates.find({ select: ['id', 'key', 'audience', 'channel', 'language', 'subject', 'body'] });
    const have = new Map(existing.map((t) => [`${t.key}|${t.audience}|${t.channel}|${t.language}`, t]));
    const rows: Partial<NotificationTemplate>[] = [];
    for (const [key, byAud] of Object.entries(DEFAULT_MESSAGES)) {
      for (const [aud, msg] of Object.entries(byAud)) {
        const chans = new Set<string>([...((matrix[key]?.[aud] as string[]) ?? []), 'IN_APP']);
        for (const channel of chans) {
          const k = `${key}|${aud}|${channel}|en`;
          const push = channel === 'PUSH' ? audienceDef(key, aud as Audience)?.push : undefined;
          const cur = have.get(k);
          if (!cur) {
            rows.push({ key, audience: aud as Audience, channel: channel as NotificationChannel, language: 'en', subject: push?.title ?? msg!.title, body: push?.body ?? msg!.body, active: true });
          } else if (push && cur.subject === msg!.title && cur.body === msg!.body) {
            // a PUSH template that still carries the untouched in-app text of an older seed: switch it to the safe push copy
            await this.templates.update(cur.id, { subject: push.title, body: push.body });
          }
        }
      }
    }
    // every registry audience with push copy gets an editable PUSH template (events whose in-app text is literal have no built-in message)
    for (const [key, def] of Object.entries(EVENTS)) {
      for (const [aud, a] of Object.entries(def.audiences)) {
        if (!a?.push || have.has(`${key}|${aud}|PUSH|en`) || rows.some((r) => r.key === key && r.audience === aud && r.channel === 'PUSH')) continue;
        rows.push({ key, audience: aud as Audience, channel: NotificationChannel.PUSH, language: 'en', subject: a.push.title, body: a.push.body, active: true });
      }
    }
    for (let i = 0; i < rows.length; i += 200) await this.templates.insert(rows.slice(i, i + 200) as any);
    await this.settings.set('notifications.templateSeedVersion', templateSeedVersion());
    if (rows.length) this.logger.log(`seeded ${rows.length} notification templates`);
  }

  /** Daily housekeeping: read in-app rows after 90 days (unread after 365), push / SMS / e-mail delivery rows after 30 days. */
  @Cron('37 3 * * *')
  async purgeOld() {
    try {
      const inApp = Number(this.settings.get<number>('notifications.retention.inAppDays', 90));
      const delivery = Number(this.settings.get<number>('notifications.retention.deliveryDays', 30));
      const a = await this.repo.query(`DELETE FROM notifications WHERE channel = 'IN_APP' AND (( "readAt" IS NOT NULL AND "createdAt" < now() - ($1 || ' days')::interval) OR "createdAt" < now() - interval '365 days')`, [String(inApp)]);
      const b = await this.repo.query(`DELETE FROM notifications WHERE channel != 'IN_APP' AND "createdAt" < now() - ($1 || ' days')::interval`, [String(delivery)]);
      this.logger.log(`notification housekeeping done (${Array.isArray(a) ? a[1] : 0} in-app, ${Array.isArray(b) ? b[1] : 0} delivery rows removed)`);
    } catch (e: any) {
      this.logger.warn(`notification housekeeping failed: ${e.message}`);
    }
  }

  // ================================================================ notify
  /** Main entry point. Never throws - notifications must not break business flows. */
  async notify(input: NotifyInput): Promise<void> {
    try {
      await this.dispatch(input);
    } catch (e: any) {
      this.logger.error(`notify(${input.event}) failed: ${e.message}`);
    }
  }

  /** Like notify() but reports what happened per channel (used by test sends and the admin tooling). Never throws. */
  async notifyDetailed(input: NotifyInput): Promise<ChannelOutcome[]> {
    try {
      return await this.dispatch(input);
    } catch (e: any) {
      this.logger.error(`notify(${input.event}) failed: ${e.message}`);
      return [{ channel: NotificationChannel.IN_APP, status: 'FAILED', error: String(e.message).slice(0, 200) }];
    }
  }

  private pushSwitch(kind: 'enabled' | 'webEnabled' | 'fcmEnabled') {
    return this.settings.get<boolean>(`notifications.push.${kind}`, true) !== false;
  }

  private async dispatch(input: NotifyInput): Promise<ChannelOutcome[]> {
    const outcomes: ChannelOutcome[] = [];
    const user = await this.users.findOne({ where: { id: input.userId } });
    if (!user || user.status === UserStatus.DELETED) return outcomes;
    const def = eventDef(input.event);
    const adef = def?.audiences[input.audience];
    const category = categoryOf(input.event);
    const matrix = this.settings.get<Record<string, Record<string, string[]>>>('notifications.matrix', {});
    let channels: NotificationChannel[] = input.channels ?? ((matrix[input.event]?.[input.audience] as NotificationChannel[]) ?? (adef?.channels as NotificationChannel[]) ?? [NotificationChannel.IN_APP]);
    const marketing = input.marketing ?? def?.marketing;
    if (marketing) channels = await this.filterByConsent(user, channels);
    const prefs = await this.prefs.get(user.id, user.type);
    const catPrefs = prefs.categories[category];
    const critical = !!(input.critical ?? adef?.critical);
    const quiet = inQuietHours(prefs.quietHours) && !(critical && prefs.criticalBypassQuietHours);
    const lang = user.language || 'en';
    const url = urlFor(input.event, input.audience, input.data ?? {});
    const wanted = new Set<NotificationChannel>([...channels]);
    // the in-app inbox is always kept for order / delivery / payment / support records; promotions and system messages can be switched off
    if (catPrefs.inApp !== false || LOCKED_IN_APP.includes(category)) wanted.add(NotificationChannel.IN_APP);
    else wanted.delete(NotificationChannel.IN_APP);
    const ordered = [NotificationChannel.IN_APP, NotificationChannel.PUSH, NotificationChannel.EMAIL, NotificationChannel.SMS].filter((c) => wanted.has(c));
    let inAppId: string | undefined;

    for (const channel of ordered) {
      if (channel === NotificationChannel.IN_APP) {
        const { title, body } = await this.render(input, channel, lang);
        const n = await this.repo.save(this.repo.create({ userId: user.id, channel, title, body, event: input.event, data: input.data ?? null, deliveryStatus: 'SENT', category, url }));
        inAppId = n.id;
        this.rt.emitToUser(user.id, 'notification', {
          id: n.id,
          title,
          body,
          event: input.event,
          data: input.data,
          at: n.createdAt,
          category,
          url,
          audience: input.audience,
          critical,
          urgency: adef?.urgency ?? 'normal',
          requireInteraction: !!adef?.requireInteraction,
          tag: adef?.tag ? fillTemplate(adef.tag, input.data ?? {}) ?? undefined : undefined,
        });
        outcomes.push({ channel, status: 'SENT', id: n.id });
        continue;
      }

      let status: 'SENT' | 'FAILED' | 'SKIPPED' = 'SENT';
      let error: string | null = null;
      let attempts = 0;
      let meta: Record<string, any> | null = null;
      let title = '';
      let body = '';
      try {
        if (channel === NotificationChannel.PUSH) {
          const p = await this.buildPush(input, user, def, adef, lang, inAppId, url);
          title = p.payload.title;
          body = p.payload.body;
          const why = def?.noPush
            ? 'this event is never sent by push'
            : !this.pushSwitch('enabled')
              ? 'push is switched off for the platform'
              : !prefs.pushEnabled
                ? 'the user turned push off'
                : catPrefs.push === false
                  ? `the user turned push off for ${category}`
                  : quiet
                    ? 'quiet hours'
                    : null;
          if (why) {
            status = 'SKIPPED';
            error = why;
            meta = { payload: p.payload };
          } else {
            const r = await this.deliverPush(user.id, p.payload, p.urgency, p.ttl);
            attempts = r.attempts;
            meta = { payload: p.payload, urgency: p.urgency, ttl: p.ttl, sent: r.sent, failed: r.failed, removed: r.removed };
            if (r.sent > 0) status = 'SENT';
            else if (r.failed > 0) (status = 'FAILED'), (error = r.errors.join('; ').slice(0, 250));
            else (status = 'SKIPPED'), (error = r.skipped ?? (r.removed ? 'subscription expired and was removed' : 'no registered device'));
            outcomes.push({ channel, status, error, sent: r.sent, failed: r.failed, removed: r.removed });
          }
          if (why) outcomes.push({ channel, status, error });
        } else {
          const r = await this.render(input, channel, lang);
          title = r.title;
          body = r.body;
          if (catPrefs[channel === NotificationChannel.EMAIL ? 'email' : 'sms'] === false) {
            status = 'SKIPPED';
            error = `the user turned ${channel.toLowerCase()} off for ${category}`;
          } else if (channel === NotificationChannel.SMS && quiet) {
            status = 'SKIPPED';
            error = 'quiet hours';
          } else if (channel === NotificationChannel.SMS && user.phone) (await this.sendSms(user.phone, body), (attempts = 1));
          else if (channel === NotificationChannel.EMAIL && user.email) (await this.sendEmail(user.email, title, body), (attempts = 1));
          else {
            status = 'SKIPPED';
            error = 'no address on file';
          }
          outcomes.push({ channel, status, error });
        }
      } catch (e: any) {
        status = 'FAILED';
        error = String(e.message ?? e).slice(0, 250);
        attempts = Math.max(attempts, 1);
        this.logger.warn(`${channel} to ${user.id} failed: ${error}`);
        outcomes.push({ channel, status, error });
      }
      await this.repo.save(
        this.repo.create({ userId: user.id, channel, title, body, event: input.event, data: input.data ?? null, deliveryStatus: status, error, category, url, attempts, meta }),
      );
    }
    return outcomes;
  }

  // ================================================================ push
  /** Safe push payload: registry copy (or an admin-edited PUSH template) rendered with allow-listed variables only. */
  private async buildPush(input: NotifyInput, user: User, def: EventDef | undefined, adef: AudienceDef | undefined, lang: string, notificationId: string | undefined, url: string) {
    const aud = input.audience;
    const allowedVars: Record<string, string> = {};
    for (const k of def?.pushVars ?? []) {
      const v = input.vars?.[k];
      if (v !== undefined && v !== null && typeof v !== 'object') allowedVars[k] = clip(String(v), 80);
    }
    let copy: { title: string; body: string } | undefined;
    if (def && adef?.push) {
      const t =
        (await this.templates.findOne({ where: { key: input.event, channel: NotificationChannel.PUSH, language: lang, audience: aud, active: true } })) ??
        (await this.templates.findOne({ where: { key: input.event, channel: NotificationChannel.PUSH, language: 'en', audience: aud, active: true } }));
      copy = { title: t?.subject ?? adef.push.title, body: t?.body ?? adef.push.body };
    }
    if (!copy) copy = { title: 'FORKSY', body: 'You have a new notification.' };
    const title = clip(scrubPush(renderTemplate(copy.title, allowedVars)) || 'FORKSY', PUSH_TITLE_MAX);
    const body = clip(scrubPush(renderTemplate(copy.body, allowedVars)), PUSH_BODY_MAX);
    const urgency: Urgency = adef?.urgency ?? 'normal';
    let ttl = adef?.ttl ?? URGENCY_TTL[urgency];
    const secs = Number(input.data?.seconds);
    if (input.event === 'driver.offer' && Number.isFinite(secs) && secs > 0) ttl = Math.min(Math.ceil(secs) + 5, ttl);
    const payload: PushPayload = {
      title,
      body,
      tag: adef?.tag ? fillTemplate(adef.tag, input.data ?? {}) ?? undefined : undefined,
      url,
      icon: '/brand/icon-192.png',
      badge: '/brand/icon-96.png',
      requireInteraction: adef?.requireInteraction || undefined,
      critical: adef?.critical || undefined,
      event: input.event,
      id: notificationId,
      data: pickAllowed(input.data, def?.pushData),
      ts: Date.now(),
    };
    return { payload, urgency, ttl };
  }

  /** Web push + native (FCM v1) for every device of the user, honouring the platform kill switches. Never throws. */
  async deliverPush(userId: string, payload: PushPayload, urgency: Urgency, ttl: number): Promise<PushResult> {
    const total: PushResult = { sent: 0, failed: 0, removed: 0, attempts: 0, errors: [] };
    const parts: Promise<PushResult>[] = [];
    if (this.pushSwitch('webEnabled')) parts.push(this.webpush.sendToUser(userId, payload, { urgency, ttl }));
    if (this.pushSwitch('fcmEnabled')) parts.push(this.fcm.sendToUser(userId, payload, { urgency, ttl }));
    if (!parts.length) return { ...total, skipped: 'web and native push are switched off for the platform' };
    const skipped: string[] = [];
    for (const r of await Promise.all(parts)) {
      total.sent += r.sent;
      total.failed += r.failed;
      total.removed += r.removed;
      total.attempts += r.attempts;
      total.errors.push(...r.errors);
      if (r.skipped) skipped.push(r.skipped);
    }
    if (!total.sent && !total.failed && !total.removed && skipped.length) total.skipped = skipped.length > 1 ? 'no registered device' : skipped[0];
    return total;
  }

  /** Legacy adapter (template test-send): push one message to a user's devices; throws when delivery failed. */
  async sendPush(userId: string, title: string, body: string, data?: Record<string, any>) {
    const payload: PushPayload = {
      title: clip(scrubPush(title), PUSH_TITLE_MAX),
      body: clip(scrubPush(body), PUSH_BODY_MAX),
      url: '/inbox',
      icon: '/brand/icon-192.png',
      badge: '/brand/icon-96.png',
      event: 'notification.test',
      tag: 'test',
      data: pickAllowed(data, []),
      ts: Date.now(),
    };
    const r = await this.deliverPush(userId, payload, 'normal', 3600);
    if (!r.sent && r.failed) throw new Error(r.errors.join('; ') || 'push failed');
    return r;
  }

  // ================================================================ audiences
  /** Notify everyone who works at a restaurant location (owner + location staff). */
  async notifyRestaurant(restaurantId: string, event: string, vars?: Record<string, any>, data?: Record<string, any>, excludeUserId?: string) {
    const rows: { merchantId: string }[] = await this.users.manager.query(`SELECT "merchantId" FROM restaurants WHERE id = $1`, [restaurantId]);
    if (!rows.length) return;
    const ms = await this.members
      .createQueryBuilder('m')
      .where('m.active = true AND m.merchantId = :mid AND (m.restaurantId IS NULL OR m.restaurantId = :rid)', { mid: rows[0].merchantId, rid: restaurantId })
      .getMany();
    const ids = [...new Set(ms.map((m) => m.userId))].filter((id) => id !== excludeUserId);
    await Promise.all(ids.map((userId) => this.notify({ userId, audience: 'RESTAURANT', event, vars, data: { ...data, restaurantId } })));
    this.rt.emitToRestaurant(restaurantId, event, { ...data, vars });
  }

  /** Staff allowed to receive an event: SUPER_ADMIN always, a role only when it grants <module>:view (events without a module go to all staff). */
  async staffFor(event: string): Promise<string[]> {
    const mod = eventDef(event)?.module;
    const staff = await this.users.find({ where: { type: In([UserType.STAFF, UserType.SUPER_ADMIN]), status: UserStatus.ACTIVE }, relations: { role: true } });
    return staff
      .filter((s) => s.type === UserType.SUPER_ADMIN || !mod || !!(s.role?.permissions as Record<string, string[]> | undefined)?.[mod]?.includes('view'))
      .map((s) => s.id);
  }

  /** Notify staff (in-app + ops room + the matrix channels, e.g. push). Optional literal copy for events without a template. */
  async notifyOps(event: string, vars?: Record<string, any>, data?: Record<string, any>, literal?: { title: string; body: string }) {
    this.rt.emitToOps(event, { ...data, vars, ...(literal ?? {}) });
    const ids = await this.staffFor(event);
    await Promise.all(ids.map((userId) => this.notify({ userId, audience: 'ADMIN', event, vars, data, ...(literal ?? {}) })));
  }

  /** Staff of a given permission (e.g. live-chat agents) without an ops-room broadcast. */
  async notifyStaff(event: string, vars?: Record<string, any>, data?: Record<string, any>, literal?: { title: string; body: string }) {
    const ids = await this.staffFor(event);
    await Promise.all(ids.map((userId) => this.notify({ userId, audience: 'ADMIN', event, vars, data, ...(literal ?? {}) })));
  }

  async render(input: NotifyInput, channel: NotificationChannel, lang: string) {
    if (input.title && input.body) {
      return { title: renderTemplate(input.title, input.vars), body: renderTemplate(input.body, input.vars) };
    }
    const tpl =
      (await this.templates.findOne({ where: { key: input.event, channel, language: lang, audience: input.audience, active: true } })) ??
      (await this.templates.findOne({ where: { key: input.event, channel, language: 'en', audience: input.audience, active: true } })) ??
      (await this.templates.findOne({ where: { key: input.event, channel: NotificationChannel.IN_APP, language: 'en', audience: input.audience, active: true } }));
    const fallback = DEFAULT_MESSAGES[input.event]?.[input.audience];
    const title = tpl?.subject ?? fallback?.title ?? input.title ?? input.event;
    const body = tpl?.body ?? fallback?.body ?? input.body ?? '';
    return { title: renderTemplate(title, input.vars), body: renderTemplate(body, input.vars) };
  }

  private async filterByConsent(user: User, channels: NotificationChannel[]) {
    if (user.type !== UserType.CUSTOMER) return channels;
    const p = await this.customers.findOne({ where: { userId: user.id } });
    return channels.filter((c) => {
      if (c === NotificationChannel.EMAIL) return !!p?.marketingEmailConsent;
      if (c === NotificationChannel.SMS) return !!p?.marketingSmsConsent;
      if (c === NotificationChannel.PUSH) return p?.pushEnabled !== false;
      return true;
    });
  }

  // ================================================================ adapters
  async sendSms(to: string, body: string) {
    const sid = this.settings.get<string>('notifications.twilioAccountSid') || this.config.get<string>('twilio.accountSid');
    const token = this.settings.get<string>('notifications.twilioAuthToken') || this.config.get<string>('twilio.authToken');
    const from = this.settings.get<string>('notifications.twilioFrom') || this.config.get<string>('twilio.from');
    if (!sid || !token || !from) {
      // never log the body: it usually contains a one-time code
      if (process.env.NODE_ENV === 'production') this.logger.error('SMS provider not configured - message to a user was NOT sent');
      else this.logger.log(`[sms:mock] -> ${to}: ${body}`);
      return;
    }
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
    });
    if (!res.ok) throw new Error(`Twilio ${res.status}`);
  }

  /**
   * The email provider chosen in Admin > System > Settings (notifications.emailProvider): "smtp" (any mail server), "sendgrid" (SendGrid API key)
   * or "ses" (Amazon SES, through its SMTP endpoint: host email-smtp.<region>.amazonaws.com with the SMTP credentials made in the SES console;
   * it uses the same SMTP fields).
   */
  private emailProvider(): 'smtp' | 'sendgrid' | 'ses' {
    const p = String(this.settings.get<string>('notifications.emailProvider') || 'sendgrid').toLowerCase();
    return p === 'smtp' || p === 'ses' ? p : 'sendgrid';
  }

  /** Which provider sends email now and whether it is filled in (for the admin screen and the test email). */
  emailStatus() {
    const provider = this.emailProvider();
    const configured =
      provider === 'smtp' || provider === 'ses'
        ? !!this.smtpConfig().host
        : provider === 'sendgrid'
          ? !!(this.settings.get<string>('notifications.sendgridApiKey') || this.config.get<string>('sendgrid.apiKey'))
          : false;
    return { provider, configured, from: this.settings.get<string>('notifications.emailFrom') || this.config.get<string>('sendgrid.from') };
  }

  private smtpConfig() {
    const host = String(this.settings.get<string>('notifications.smtp.host') ?? '').trim();
    const port = Number(this.settings.get<number>('notifications.smtp.port') ?? 587) || 587;
    const user = String(this.settings.get<string>('notifications.smtp.user') ?? '').trim();
    const pass = String(this.settings.get<string>('notifications.smtp.password') ?? '');
    const secure = this.settings.get<boolean>('notifications.smtp.secure') === true || port === 465;
    return { host, port, user, pass, secure };
  }

  /**
   * Sends one plain-text email. Throws when it could not be sent, so the caller (OTP, notifications) records the failure; a provider that is
   * not configured at all is logged as an error in production (the message is NOT sent) and mocked in development.
   */
  async sendEmail(to: string, subject: string, body: string) {
    const from = this.settings.get<string>('notifications.emailFrom') || this.config.get<string>('sendgrid.from');
    const provider = this.emailProvider();

    if (provider === 'smtp' || provider === 'ses') {
      const c = this.smtpConfig();
      if (!c.host) {
        if (process.env.NODE_ENV === 'production') this.logger.error(`Email provider is "${provider}" but the SMTP server is not filled in (Admin > System > Settings > notifications) - message to a user was NOT sent`);
        else this.logger.log(`[email:mock] -> ${to}: ${subject}`);
        return;
      }
      const transport = nodemailer.createTransport({
        host: c.host,
        port: c.port,
        secure: c.secure,
        requireTLS: !c.secure, // never send the password in clear text: STARTTLS is required on the plain port
        auth: c.user ? { user: c.user, pass: c.pass } : undefined,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
      });
      try {
        await transport.sendMail({ from, to, subject, text: body });
      } catch (e: any) {
        throw new Error(`SMTP ${e?.code ? e.code + ': ' : ''}${e?.responseCode ? e.responseCode + ' ' : ''}${String(e?.message ?? e).slice(0, 200)}`);
      } finally {
        transport.close();
      }
      return;
    }

    const key = this.settings.get<string>('notifications.sendgridApiKey') || this.config.get<string>('sendgrid.apiKey');
    if (!key) {
      if (process.env.NODE_ENV === 'production') this.logger.error('Email provider not configured - message to a user was NOT sent');
      else this.logger.log(`[email:mock] -> ${to}: ${subject}`);
      return;
    }
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: from },
        subject,
        content: [{ type: 'text/plain', value: body }],
      }),
    });
    if (!res.ok) throw new Error(`SendGrid ${res.status}`);
  }

  // ================================================================ notification center (inbox) - every query is scoped to the caller
  private toView(n: Notification, audience: Audience) {
    return {
      id: n.id,
      title: n.title,
      body: n.body,
      event: n.event,
      category: n.category ?? (n.event ? categoryOf(n.event) : 'system'),
      data: n.data,
      url: n.url ?? (n.event ? urlFor(n.event, audience, n.data ?? {}) : BASE_URL[audience]),
      readAt: n.readAt,
      createdAt: n.createdAt,
    };
  }

  /** Cursor pagination (newest first). `page` is still honoured for the older clients. */
  async list(userId: string, userType: UserType | string, q: InboxQuery) {
    const audience = audienceOfUser(userType);
    const limit = Math.min(Math.max(Math.trunc(Number(q.limit) || 30), 1), 100);
    const qb = this.repo.createQueryBuilder('n').where('n.userId = :userId AND n.channel = :ch', { userId, ch: NotificationChannel.IN_APP });
    if (q.unread) qb.andWhere('n.readAt IS NULL');
    if (q.category && CATEGORY_KEYS.includes(q.category as any)) qb.andWhere('n.category = :cat', { cat: q.category });
    qb.orderBy('n.createdAt', 'DESC').addOrderBy('n.id', 'DESC');
    const meta: Record<string, any> = { limit };
    let rows: Notification[];
    if (q.page && !q.cursor) {
      const page = Math.max(1, Math.trunc(Number(q.page)) || 1);
      const [data, total] = await qb.skip((page - 1) * limit).take(limit).getManyAndCount();
      rows = data;
      Object.assign(meta, { page, total, totalPages: Math.max(1, Math.ceil(total / limit)), hasMore: page * limit < total });
    } else {
      const cur = decodeCursor(q.cursor);
      if (q.cursor && !cur) throw new BadRequestException('Invalid cursor');
      if (cur) qb.andWhere('(n.createdAt, n.id) < (:at, :id)', { at: cur.at, id: cur.id });
      const data = await qb.take(limit + 1).getMany();
      const hasMore = data.length > limit;
      rows = hasMore ? data.slice(0, limit) : data;
      meta.hasMore = hasMore;
    }
    const last = rows[rows.length - 1];
    return {
      data: rows.map((n) => this.toView(n, audience)),
      nextCursor: meta.hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
      unread: await this.unreadCount(userId),
      meta,
    };
  }

  unreadCount(userId: string) {
    return this.repo.count({ where: { userId, channel: NotificationChannel.IN_APP, readAt: IsNull() } });
  }

  /** Mark one (id) or every unread notification of THIS user as read. Returns how many changed. */
  async markRead(userId: string, id?: string): Promise<number> {
    const qb = this.repo
      .createQueryBuilder()
      .update(Notification)
      .set({ readAt: new Date() })
      .where('"userId" = :userId AND "readAt" IS NULL AND channel = :ch', { userId, ch: NotificationChannel.IN_APP });
    if (id) qb.andWhere('id = :id', { id });
    const r = await qb.execute();
    if (r.affected) this.rt.emitToUser(userId, 'notification.read', { id: id ?? null, all: !id, unread: await this.unreadCount(userId) });
    return r.affected ?? 0;
  }

  /** read-state of a single notification: false when it is not the caller's */
  async ownsInApp(userId: string, id: string) {
    return this.repo.exist({ where: { id, userId, channel: NotificationChannel.IN_APP } });
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const r = await this.repo.delete({ id, userId, channel: NotificationChannel.IN_APP });
    if (r.affected) this.rt.emitToUser(userId, 'notification.read', { id, deleted: true, unread: await this.unreadCount(userId) });
    return (r.affected ?? 0) > 0;
  }

  /** legacy offset inbox (kept for older callers) */
  inbox(userId: string, page = 1, limit = 30) {
    return this.repo.findAndCount({ where: { userId, channel: NotificationChannel.IN_APP }, order: { createdAt: 'DESC' }, skip: (page - 1) * limit, take: limit });
  }

  // ================================================================ native device tokens (FCM)
  async registerDevice(userId: string, dto: { token: string; platform?: 'ios' | 'android'; app?: any; appVersion?: string; fingerprint?: string }) {
    const existing = await this.tokens.findOne({ where: { token: dto.token } });
    if (existing) {
      // the token now belongs to whoever registers it (a phone that changed hands)
      Object.assign(existing, { userId, platform: dto.platform ?? existing.platform, app: dto.app ?? existing.app, appVersion: dto.appVersion ?? existing.appVersion, fingerprint: dto.fingerprint ?? existing.fingerprint, lastSeenAt: new Date(), failures: 0 });
      return this.tokens.save(existing);
    }
    return this.tokens.save(this.tokens.create({ userId, ...dto, lastSeenAt: new Date() } as any) as unknown as DeviceToken);
  }

  async unregisterDevice(userId: string, token: string) {
    const r = await this.tokens.delete({ token, userId });
    return (r.affected ?? 0) > 0;
  }

  /** every device of the user (browsers + native), without secrets */
  async devices(userId: string, currentEndpoint?: string) {
    const [web, native] = await Promise.all([this.webpush.forUser(userId), this.tokens.find({ where: { userId }, order: { createdAt: 'DESC' } })]);
    return [
      ...web.map((s) => ({ id: s.id, kind: 'web' as const, app: s.app, platform: 'web', label: describeAgent(s.userAgent), createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, lastSuccessAt: s.lastSuccessAt, failures: s.failures, current: !!currentEndpoint && s.endpoint === currentEndpoint })),
      ...native.map((d) => ({ id: d.id, kind: 'native' as const, app: d.app, platform: d.platform, label: `${d.platform === 'ios' ? 'iOS' : 'Android'} app${d.appVersion ? ' ' + d.appVersion : ''}`, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt ?? d.updatedAt, lastSuccessAt: null, failures: d.failures ?? 0, current: false })),
    ];
  }

  async removeDevice(userId: string, id: string): Promise<boolean> {
    if (await this.webpush.removeById(userId, id)) return true;
    const r = await this.tokens.delete({ id, userId });
    return (r.affected ?? 0) > 0;
  }

  // ================================================================ delivery log (admin)
  async deliveryLog(f: { userId?: string; channel?: string; status?: string; event?: string; q?: string; from?: Date; to?: Date; page?: number; limit?: number }) {
    const page = Math.max(1, f.page ?? 1);
    const limit = Math.min(Math.max(f.limit ?? 25, 1), 200);
    const qb = this.repo
      .createQueryBuilder('n')
      .leftJoin(User, 'u', 'u.id = n.userId')
      .select(['n.id', 'n.userId', 'n.channel', 'n.title', 'n.event', 'n.category', 'n.deliveryStatus', 'n.error', 'n.attempts', 'n.createdAt', 'n.meta'])
      .addSelect(['u.email', 'u.firstName', 'u.lastName', 'u.type'])
      .where('n.channel != :inapp', { inapp: NotificationChannel.IN_APP });
    if (f.userId) qb.andWhere('n.userId = :uid', { uid: f.userId });
    if (f.channel) qb.andWhere('n.channel = :ch', { ch: f.channel });
    if (f.status) qb.andWhere('n.deliveryStatus = :st', { st: f.status });
    if (f.event) qb.andWhere('n.event = :ev', { ev: f.event });
    if (f.q) qb.andWhere('(u.email ILIKE :q OR n.event ILIKE :q OR n.title ILIKE :q OR n.error ILIKE :q)', { q: `%${f.q.replace(/[%_\\]/g, (m) => '\\' + m).slice(0, 80)}%` });
    if (f.from) qb.andWhere('n.createdAt >= :from', { from: f.from });
    if (f.to) qb.andWhere('n.createdAt <= :to', { to: f.to });
    qb.orderBy('n.createdAt', 'DESC').addOrderBy('n.id', 'DESC').offset((page - 1) * limit).limit(limit);
    const [raw, total] = await Promise.all([qb.getRawMany(), qb.getCount()]);
    return {
      data: raw.map((r) => ({
        id: r.n_id,
        userId: r.n_userId,
        user: r.u_email ?? `${r.u_firstName ?? ''} ${r.u_lastName ?? ''}`.trim() ?? null,
        userType: r.u_type ?? null,
        channel: r.n_channel,
        title: r.n_title,
        event: r.n_event,
        category: r.n_category,
        status: r.n_deliveryStatus,
        error: r.n_error,
        attempts: r.n_attempts,
        createdAt: r.n_createdAt,
        result: r.n_meta ? { sent: r.n_meta.sent ?? null, failed: r.n_meta.failed ?? null, removed: r.n_meta.removed ?? null } : null,
      })),
      meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  /** Re-send a FAILED / SKIPPED delivery row (push re-uses the stored sanitised payload). */
  async retryDelivery(id: string): Promise<{ status: string; error: string | null }> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row || row.channel === NotificationChannel.IN_APP) throw new NotFoundException('Delivery not found');
    if (row.deliveryStatus === 'SENT') throw new BadRequestException('This delivery was already sent');
    const user = await this.users.findOne({ where: { id: row.userId } });
    if (!user) throw new NotFoundException('User not found');
    let status: Notification['deliveryStatus'] = 'SENT';
    let error: string | null = null;
    try {
      if (row.channel === NotificationChannel.PUSH) {
        const payload = row.meta?.payload as PushPayload | undefined;
        if (!payload) throw new Error('no stored payload to resend');
        const r = await this.deliverPush(user.id, { ...payload, ts: Date.now() }, (row.meta?.urgency as Urgency) ?? 'normal', Number(row.meta?.ttl) || 3600);
        row.meta = { ...(row.meta ?? {}), sent: r.sent, failed: r.failed, removed: r.removed, retriedAt: new Date().toISOString() };
        if (r.sent > 0) status = 'SENT';
        else if (r.failed > 0) (status = 'FAILED'), (error = r.errors.join('; ').slice(0, 250));
        else (status = 'SKIPPED'), (error = r.skipped ?? 'no registered device');
        row.attempts += r.attempts;
      } else if (row.channel === NotificationChannel.SMS && user.phone) (await this.sendSms(user.phone, row.body), row.attempts++);
      else if (row.channel === NotificationChannel.EMAIL && user.email) (await this.sendEmail(user.email, row.title, row.body), row.attempts++);
      else (status = 'SKIPPED'), (error = 'no address on file');
    } catch (e: any) {
      status = 'FAILED';
      error = String(e.message ?? e).slice(0, 250);
    }
    row.deliveryStatus = status;
    row.error = error;
    await this.repo.save(row);
    return { status, error };
  }
}

/** "Chrome on Windows" style label from a user agent (no versions: it is shown in settings lists). */
export function describeAgent(ua?: string | null): string {
  if (!ua) return 'Browser';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iOS/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}
