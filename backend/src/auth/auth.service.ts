import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, Logger, UnauthorizedException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes, randomInt } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';
import { DataSource, In, IsNull, MoreThan, Repository } from 'typeorm';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import {
  City,
  Zone,
  CustomerProfile,
  Cuisine,
  DriverProfile,
  Merchant,
  OtpCode,
  OtpPurpose,
  RefreshToken,
  Referral,
  Restaurant,
  RestaurantMember,
  User,
} from '../database/entities';
import { AuthUser, JwtPayload } from '../common/auth.types';
import { DriverStatus, RestaurantRole, RestaurantStatus, StoreType, UserStatus, UserType, VerificationMethod } from '../common/enums';
import { storeTypeDefaults } from '../restaurants/restaurants.util';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Events, SubjectRegisteredEvent } from '../common/contracts';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { JwtStrategy } from './jwt.strategy';
import { LoginProtection } from './login-protection.service';
import { seal, unseal } from '../common/secretbox';
import { ChangePasswordDto, CustomerRegisterDto, DriverRegisterDto, LoginDto, RestaurantApplyDto, SocialLoginDto } from './dto';

/** Used to burn the same CPU time when the account does not exist (no timing-based user enumeration). */
const DUMMY_HASHES: Record<number, string> = { 10: bcrypt.hashSync('forksy-dummy-password-never-valid', 10), 12: bcrypt.hashSync('forksy-dummy-password-never-valid', 12) };
let lastRounds = 12; // bcrypt cost of the most recently seen real hash: the dummy compare mimics it
const COMMON_PASSWORDS = new Set(['password','password1','password123','passw0rd','12345678','123456789','1234567890','qwerty123','qwertyuiop','iloveyou1','welcome1','welcome123','admin123','admin@123','letmein123','abc12345','abcd1234','changeme1','forksy123','forksy@123','p@ssw0rd','p@ssword1','test1234','test@1234']);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

export interface ReqCtx {
  ip?: string;
  userAgent?: string;
  deviceInfo?: string;
}

const APP_TYPES: Record<string, UserType[]> = {
  admin: [UserType.STAFF, UserType.SUPER_ADMIN],
  restaurant: [UserType.RESTAURANT],
  driver: [UserType.DRIVER],
  customer: [UserType.CUSTOMER],
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private appleJwks = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

  constructor(
    private jwt: JwtService,
    private config: ConfigService,
    private audit: AuditService,
    private settings: SettingsService,
    private notifications: NotificationsService,
    private strategy: JwtStrategy,
    private protect: LoginProtection,
    private events: EventEmitter2,
    @InjectDataSource() private ds: DataSource,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(RefreshToken) private refreshTokens: Repository<RefreshToken>,
    @InjectRepository(OtpCode) private otps: Repository<OtpCode>,
    @InjectRepository(CustomerProfile) private customers: Repository<CustomerProfile>,
    @InjectRepository(DriverProfile) private drivers: Repository<DriverProfile>,
    @InjectRepository(Referral) private referrals: Repository<Referral>,
  ) {}

  // ------------------------------------------------------------------ helpers
  private isEmail(v: string) {
    return v.includes('@');
  }

  normalizePhone(p: string) {
    const digits = p.replace(/[^\d+]/g, '');
    if (digits.startsWith('+')) return digits;
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return `+${digits}`;
  }

  async findByIdentifier(identifier: string, withSecrets = true) {
    const id = identifier.trim();
    const where = this.isEmail(id) ? { email: id.toLowerCase() } : { phone: this.normalizePhone(id) };
    const qb = this.users.createQueryBuilder('u').where(this.isEmail(id) ? 'u.email = :v' : 'u.phone = :v', { v: Object.values(where)[0] });
    if (withSecrets) qb.addSelect(['u.passwordHash', 'u.twoFactorSecret']);
    return qb.getOne();
  }

  private accessToken(user: User, extra: Partial<JwtPayload> = {}) {
    const payload: JwtPayload = { sub: user.id, type: user.type, tv: user.tokenVersion ?? 0, ...extra };
    return this.jwt.sign(payload, { expiresIn: extra.pending2fa ? '5m' : (this.config.get('jwt.accessTtl') as any) });
  }

  private async issueRefresh(user: User, ctx: ReqCtx) {
    const raw = randomBytes(48).toString('base64url');
    const days = this.config.get<number>('jwt.refreshTtlDays');
    await this.refreshTokens.save(
      this.refreshTokens.create({
        userId: user.id,
        tokenHash: sha(raw),
        expiresAt: new Date(Date.now() + days * 86400_000),
        deviceInfo: ctx.deviceInfo ?? ctx.userAgent?.slice(0, 200) ?? null,
        ip: ctx.ip ?? null,
      }),
    );
    return raw;
  }

  async publicUser(user: User) {
    const au = await this.strategy.validate({ sub: user.id, type: user.type, tv: user.tokenVersion ?? 0 });
    this.strategy.invalidate(user.id);
    const { pending2fa, ...rest } = au as any;
    return {
      ...rest,
      firstName: user.firstName,
      lastName: user.lastName,
      avatarUrl: user.avatarUrl,
      language: user.language,
      twoFactorEnabled: user.twoFactorEnabled,
      emailVerified: user.emailVerified,
      phoneVerified: user.phoneVerified,
      lastLoginAt: user.lastLoginAt,
    };
  }

  /** Issue access + refresh tokens for an already-authenticated user. */
  async completeLogin(user: User, ctx: ReqCtx) {
    user.lastLoginAt = new Date();
    user.lastLoginIp = ctx.ip ?? null;
    user.failedLoginCount = 0;
    user.lockedUntil = null;
    await this.users.update(user.id, { lastLoginAt: user.lastLoginAt, lastLoginIp: user.lastLoginIp, failedLoginCount: 0, lockedUntil: null });
    await this.audit.log({ actor: { id: user.id, email: user.email, type: user.type }, action: 'auth.login', entity: 'user', entityId: user.id, ip: ctx.ip, userAgent: ctx.userAgent });
    return {
      accessToken: this.accessToken(user),
      refreshToken: await this.issueRefresh(user, ctx),
      expiresIn: this.config.get('jwt.accessTtl'),
      user: await this.publicUser(user),
    };
  }

  /** 2FA is mandatory for staff & restaurant owners when enforced (spec 10.1). */
  private async needs2fa(user: User) {
    if (user.type === UserType.STAFF || user.type === UserType.SUPER_ADMIN) {
      return this.config.get('security.enforce2fa') && this.settings.get('security.enforce2faStaff', true);
    }
    if (user.type === UserType.RESTAURANT) {
      const owner = await this.ds.getRepository(RestaurantMember).findOne({ where: { userId: user.id, role: RestaurantRole.OWNER } });
      return !!owner && this.config.get('security.enforce2fa') && this.settings.get('security.enforce2faRestaurantOwner', true);
    }
    return false;
  }

  // ------------------------------------------------------------------ login
  /** Failed credential check: progressive per-IP / per-identifier lockout + audit. Never tells the caller which part was wrong. */
  private async onLoginFailure(user: User | null, identifier: string, ctx: ReqCtx, scope = 'login') {
    const ip = ctx.ip ?? 'unknown';
    const r = this.protect.fail(ip, identifier, scope);
    if (user && scope === 'login') {
      const fails = (user.failedLoginCount ?? 0) + 1;
      await this.users.update(user.id, {
        failedLoginCount: r.blocked === 'identifier' ? 0 : fails,
        lockedUntil: r.blocked === 'identifier' ? new Date(Date.now() + r.seconds * 1000) : user.lockedUntil,
      });
    }
    await this.audit.log({
      actor: user ? { id: user.id, email: user.email, type: user.type } : null,
      action: r.blocked ? `auth.lockout_${scope}` : `auth.${scope === 'login' ? 'login' : scope}_failed`,
      entity: 'user',
      entityId: user?.id,
      after: user ? undefined : { identifier: identifier.slice(0, 80) },
      ip,
      userAgent: ctx.userAgent,
    });
  }

  async login(dto: LoginDto, ctx: ReqCtx) {
    const ip = ctx.ip ?? 'unknown';
    this.protect.check(ip, dto.identifier); // 429 - identical for known / unknown accounts
    const user = await this.findByIdentifier(dto.identifier);
    // always run bcrypt (dummy hash if the account does not exist) so timing does not reveal existence
    if (user?.passwordHash) lastRounds = bcrypt.getRounds(user.passwordHash) <= 10 ? 10 : 12;
    const ok = await bcrypt.compare(dto.password, user?.passwordHash || DUMMY_HASHES[lastRounds]);
    if (!user || !user.passwordHash || !ok) {
      await this.onLoginFailure(user ?? null, dto.identifier, ctx);
      throw new UnauthorizedException('Invalid credentials');
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new HttpException({ statusCode: 429, message: 'Too many attempts. Please try again later.' }, HttpStatus.TOO_MANY_REQUESTS);
    }
    this.protect.success(dto.identifier);
    // transparently upgrade old, cheaper hashes to the current cost
    if (bcrypt.getRounds(user.passwordHash) < 12) {
      bcrypt.hash(dto.password, 12).then((h) => this.users.update(user.id, { passwordHash: h })).catch(() => undefined);
    }
    if (user.status === UserStatus.BLOCKED || user.status === UserStatus.DELETED) throw new ForbiddenException('Account is blocked');
    if (user.status === UserStatus.SUSPENDED) throw new ForbiddenException('Account is suspended. Contact support.');
    if (dto.app && !APP_TYPES[dto.app].includes(user.type)) throw new ForbiddenException(`This account cannot sign in to the ${dto.app} app`);

    if (user.twoFactorEnabled) {
      return { requires2fa: true, tempToken: this.accessToken(user, { pending2fa: true }) };
    }
    if (await this.needs2fa(user)) {
      return { requires2faSetup: true, tempToken: this.accessToken(user, { pending2fa: true }) };
    }
    return this.completeLogin(user, ctx);
  }

  async verify2fa(tempToken: string, code: string, ctx: ReqCtx) {
    let payload: JwtPayload;
    try {
      payload = this.jwt.verify<JwtPayload>(tempToken, { secret: this.config.get('jwt.secret'), algorithms: ['HS256'] });
    } catch {
      throw new UnauthorizedException('Session expired, sign in again');
    }
    if (!payload.pending2fa) throw new BadRequestException();
    this.protect.check(ctx.ip ?? 'unknown', payload.sub, '2fa'); // brute-forcing the 6 digit code is locked out per user
    const user = await this.users.createQueryBuilder('u').addSelect('u.twoFactorSecret').where('u.id = :id', { id: payload.sub }).getOne();
    if (!user?.twoFactorSecret || !authenticator.verify({ token: code, secret: unseal(user.twoFactorSecret) }) || this.totpReplayed(user.id, code)) {
      await this.onLoginFailure(user ?? null, payload.sub, ctx, '2fa');
      throw new UnauthorizedException('Invalid authentication code');
    }
    this.protect.success(payload.sub, '2fa');
    return this.completeLogin(user, ctx);
  }

  private usedTotp = new Map<string, number>();
  /** A TOTP code may be used once (replay within its validity window is rejected). */
  private totpReplayed(userId: string, code: string): boolean {
    const key = `${userId}:${code}`;
    const now = Date.now();
    for (const [k, t] of this.usedTotp) if (now - t > 120_000) this.usedTotp.delete(k);
    if (this.usedTotp.has(key)) return true;
    this.usedTotp.set(key, now);
    return false;
  }

  /** Step 1 of enrolment (accepts the pending-2fa token or a full session). */
  async setup2fa(userId: string) {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException();
    const secret = authenticator.generateSecret();
    await this.users.update(userId, { twoFactorSecret: seal(secret), twoFactorEnabled: false });
    const label = user.email ?? user.phone ?? user.id;
    const otpauthUrl = authenticator.keyuri(label, 'FORKSY', secret);
    return { secret, otpauthUrl, qrCode: await QRCode.toDataURL(otpauthUrl) };
  }

  /** Step 2: confirm code. If called with a pending token this also completes the login. */
  async enable2fa(userId: string, code: string, ctx: ReqCtx, completeLogin: boolean) {
    const user = await this.users.createQueryBuilder('u').addSelect('u.twoFactorSecret').where('u.id = :id', { id: userId }).getOne();
    if (!user?.twoFactorSecret) throw new BadRequestException('Start 2FA setup first');
    if (!authenticator.verify({ token: code, secret: unseal(user.twoFactorSecret) })) throw new BadRequestException('Invalid code');
    await this.users.update(userId, { twoFactorEnabled: true });
    await this.audit.log({ actor: { id: user.id, email: user.email, type: user.type }, action: 'auth.2fa_enabled', entity: 'user', entityId: user.id, ip: ctx.ip });
    this.strategy.invalidate(userId);
    if (completeLogin) return this.completeLogin(user, ctx);
    return { enabled: true };
  }

  async disable2fa(userId: string, password: string) {
    const user = await this.users.createQueryBuilder('u').addSelect('u.passwordHash').where('u.id = :id', { id: userId }).getOne();
    if (!user || !(await bcrypt.compare(password, user.passwordHash ?? ''))) throw new UnauthorizedException('Wrong password');
    if (await this.needs2fa(user)) throw new ForbiddenException('2FA is mandatory for your account');
    await this.users.update(userId, { twoFactorEnabled: false, twoFactorSecret: null });
    return { enabled: false };
  }

  // ------------------------------------------------------------------ refresh / logout
  async refresh(raw: string, ctx: ReqCtx) {
    const rt = await this.refreshTokens.findOne({ where: { tokenHash: sha(raw) } });
    if (!rt || rt.revokedAt || rt.expiresAt < new Date()) {
      if (rt?.revokedAt) await this.refreshTokens.update({ userId: rt.userId, revokedAt: IsNull() }, { revokedAt: new Date() }); // reuse detected
      throw new UnauthorizedException('Invalid refresh token');
    }
    const user = await this.users.findOne({ where: { id: rt.userId } });
    if (!user || [UserStatus.BLOCKED, UserStatus.DELETED, UserStatus.SUSPENDED].includes(user.status)) throw new UnauthorizedException();
    // atomic rotation: only one concurrent caller can consume a refresh token; the loser is treated as token reuse
    const rotated = await this.refreshTokens.update({ id: rt.id, revokedAt: IsNull() }, { revokedAt: new Date() });
    if (!rotated.affected) {
      await this.refreshTokens.update({ userId: rt.userId, revokedAt: IsNull() }, { revokedAt: new Date() });
      throw new UnauthorizedException('Invalid refresh token');
    }
    return {
      accessToken: this.accessToken(user),
      refreshToken: await this.issueRefresh(user, ctx),
      expiresIn: this.config.get('jwt.accessTtl'),
    };
  }

  async logout(raw?: string) {
    if (raw) await this.refreshTokens.update({ tokenHash: sha(raw) }, { revokedAt: new Date() });
    return { ok: true };
  }

  /** Revoke every refresh token AND every access token issued so far (tokensValidAfter). */
  async logoutAll(userId: string) {
    const now = new Date();
    await this.refreshTokens.update({ userId, revokedAt: IsNull() }, { revokedAt: now });
    await this.users.update(userId, { tokensValidAfter: now, tokenVersion: () => '"tokenVersion" + 1' });
    this.strategy.invalidate(userId);
    return { ok: true };
  }

  // ------------------------------------------------------------------ password
  private checkPassword(pw: string) {
    const min = Math.min(Math.max(8, Number(this.settings.get<number>('security.passwordMinLength', 10)) || 10), 64);
    if (typeof pw !== 'string' || pw.length < min) throw new BadRequestException(`Password must be at least ${min} characters`);
    if (pw.length > 128) throw new BadRequestException('Password is too long (max 128 characters)');
    if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw new BadRequestException('Password must contain letters and numbers');
    if (COMMON_PASSWORDS.has(pw.toLowerCase()) || /^(.)\1+$/.test(pw)) throw new BadRequestException('That password is too common - choose a different one');
  }

  hash(pw: string) {
    this.checkPassword(pw);
    return bcrypt.hash(pw, 12);
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.users.createQueryBuilder('u').addSelect('u.passwordHash').where('u.id = :id', { id: userId }).getOne();
    if (!user || !(await bcrypt.compare(dto.currentPassword, user.passwordHash ?? ''))) throw new UnauthorizedException('Current password is wrong');
    if (dto.newPassword === dto.currentPassword) throw new BadRequestException('Choose a different password');
    await this.users.update(userId, { passwordHash: await this.hash(dto.newPassword), passwordChangedAt: new Date() });
    await this.logoutAll(userId); // every other session (access + refresh tokens) is revoked
    await this.audit.log({ actor: { id: user.id, email: user.email, type: user.type }, action: 'auth.password_changed', entity: 'user', entityId: userId });
    // keep the current device signed in with fresh tokens
    const fresh = await this.users.findOne({ where: { id: userId } });
    return { ok: true, accessToken: this.accessToken(fresh!), refreshToken: await this.issueRefresh(fresh!, {}), expiresIn: this.config.get('jwt.accessTtl') };
  }

  async forgotPassword(identifier: string) {
    const user = await this.findByIdentifier(identifier, false);
    // Always answer OK in the same shape (no account enumeration, no "wait a moment" / rate leak for real accounts)
    if (!user) return { ok: true };
    const target = (this.isEmail(identifier) ? user.email : user.phone)!;
    if (await this.otpCapReached(target, 'RESET_PASSWORD')) return { ok: true };
    const expose = this.config.get('security.exposeOtp') && this.config.get('env') !== 'production';
    if (!expose) {
      this.sendOtp(target, 'RESET_PASSWORD', user.type).catch(() => undefined); // not awaited: response time matches unknown accounts
      return { ok: true };
    }
    const { devCode } = await this.sendOtp(target, 'RESET_PASSWORD', user.type).catch(() => ({ devCode: undefined }));
    return { ok: true, ...(devCode ? { devCode } : {}) };
  }

  async resetPassword(identifier: string, code: string, newPassword: string, ip = 'unknown') {
    this.protect.check(ip, identifier, 'reset');
    const user = await this.findByIdentifier(identifier, false);
    if (!user) {
      this.protect.fail(ip, identifier, 'reset');
      throw new BadRequestException('Invalid or expired code');
    }
    const target = this.isEmail(identifier) ? user.email : user.phone;
    try {
      await this.consumeOtp(target!, 'RESET_PASSWORD', code);
    } catch (e) {
      this.protect.fail(ip, identifier, 'reset');
      throw e;
    }
    this.protect.success(identifier, 'reset');
    await this.users.update(user.id, { passwordHash: await this.hash(newPassword), passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null });
    await this.logoutAll(user.id);
    await this.audit.log({ actor: { id: user.id, email: user.email, type: user.type }, action: 'auth.password_reset', entity: 'user', entityId: user.id });
    return { ok: true };
  }

  // ------------------------------------------------------------------ OTP
  /** SMS-pumping / mail-bombing guard: at most 5 codes per target+purpose per hour. */
  private async otpCapReached(target: string, purpose: OtpPurpose) {
    const t = this.isEmail(target) ? target.toLowerCase() : this.normalizePhone(target);
    const n = await this.otps.count({ where: { target: t, purpose, createdAt: MoreThan(new Date(Date.now() - 3600_000)) } });
    return n >= 5;
  }

  async sendOtp(target: string, purpose: OtpPurpose, type: UserType = UserType.CUSTOMER) {
    const t = this.isEmail(target) ? target.toLowerCase() : this.normalizePhone(target);
    if (await this.otpCapReached(t, purpose)) throw new HttpException({ statusCode: 429, message: 'Too many codes requested. Please try again later.' }, HttpStatus.TOO_MANY_REQUESTS);
    const recent = await this.otps.findOne({ where: { target: t, purpose, createdAt: MoreThan(new Date(Date.now() - 45_000)) } });
    if (recent) throw new BadRequestException('Please wait a moment before requesting another code');
    const code = String(randomInt(100000, 999999));
    const ttl = this.config.get<number>('security.otpTtlMinutes');
    await this.otps.save(this.otps.create({ target: t, purpose, codeHash: sha(`${t}:${code}`), expiresAt: new Date(Date.now() + ttl * 60_000) }));
    const body = `Your FORKSY verification code is ${code}. It expires in ${ttl} minutes.`;
    try {
      if (this.isEmail(t)) await this.notifications.sendEmail(t, 'Your FORKSY code', body);
      else await this.notifications.sendSms(t, body);
    } catch (e: any) {
      this.logger.warn(`OTP delivery failed: ${e.message}`);
    }
    const expose = this.config.get('security.exposeOtp') && this.config.get('env') !== 'production';
    if (expose) this.logger.log(`[otp] ${t} (${purpose}) = ${code}`);
    return { devCode: expose ? code : undefined };
  }

  async consumeOtp(target: string, purpose: OtpPurpose, code: string) {
    const t = this.isEmail(target) ? target.toLowerCase() : this.normalizePhone(target);
    const rec = await this.otps.findOne({ where: { target: t, purpose, consumedAt: IsNull(), expiresAt: MoreThan(new Date()) }, order: { createdAt: 'DESC' } });
    if (!rec || rec.attempts >= 5) throw new BadRequestException('Invalid or expired code');
    if (rec.codeHash !== sha(`${t}:${code}`)) {
      await this.otps.update(rec.id, { attempts: rec.attempts + 1 });
      throw new BadRequestException('Invalid or expired code');
    }
    await this.otps.update(rec.id, { consumedAt: new Date() });
  }

  async requestLoginOtp(phone: string, app: 'customer' | 'driver' | 'restaurant' = 'customer') {
    const p = this.normalizePhone(phone);
    const existing = await this.users.findOne({ where: { phone: p } });
    if (existing && !APP_TYPES[app].includes(existing.type)) throw new ForbiddenException(`This phone is registered to a different kind of account`);
    return { ok: true, isNewUser: !existing, ...(await this.sendOtp(p, existing ? 'LOGIN' : 'SIGNUP')) };
  }

  /** Phone OTP sign-in. Unknown phone + app=customer => auto sign-up. */
  async verifyLoginOtp(
    dto: { phone: string; code: string; app?: 'customer' | 'driver' | 'restaurant'; firstName?: string; lastName?: string; email?: string; referralCode?: string },
    ctx: ReqCtx,
  ) {
    const app = dto.app ?? 'customer';
    const p = this.normalizePhone(dto.phone);
    const ip = ctx.ip ?? 'unknown';
    this.protect.check(ip, p, 'otp');
    let user = await this.users.findOne({ where: { phone: p } });
    try {
      await this.consumeOtp(p, user ? 'LOGIN' : 'SIGNUP', dto.code);
    } catch (e) {
      this.protect.fail(ip, p, 'otp');
      throw e;
    }
    this.protect.success(p, 'otp');
    if (!user) {
      if (app !== 'customer') throw new NotFoundException('No account for this phone. Please register first.');
      user = await this.createCustomer({ phone: p, firstName: dto.firstName ?? '', lastName: dto.lastName ?? '', email: dto.email, referralCode: dto.referralCode, phoneVerified: true });
    } else if (!APP_TYPES[app].includes(user.type)) {
      throw new ForbiddenException('Wrong app for this account');
    }
    if (user.status === UserStatus.BLOCKED || user.status === UserStatus.DELETED || user.status === UserStatus.SUSPENDED) throw new ForbiddenException('Account is not active');
    if (!user.phoneVerified) await this.users.update(user.id, { phoneVerified: true });
    return this.completeLogin(user, ctx);
  }

  // ------------------------------------------------------------------ customer sign-up
  private async uniqueReferralCode() {
    for (let i = 0; i < 10; i++) {
      const code = randomBytes(4).toString('hex').toUpperCase().slice(0, 7);
      if (!(await this.customers.findOne({ where: { referralCode: code } }))) return code;
    }
    return randomBytes(6).toString('hex').toUpperCase();
  }

  async createCustomer(input: {
    email?: string;
    phone?: string;
    password?: string;
    firstName: string;
    lastName: string;
    referralCode?: string;
    marketingEmailConsent?: boolean;
    marketingSmsConsent?: boolean;
    language?: string;
    phoneVerified?: boolean;
    emailVerified?: boolean;
    googleId?: string;
    appleId?: string;
  }) {
    if (!input.email && !input.phone) throw new BadRequestException('Email or phone is required');
    const email = input.email?.toLowerCase() ?? null;
    const phone = input.phone ? this.normalizePhone(input.phone) : null;
    if (email && (await this.users.findOne({ where: { email } }))) throw new ConflictException('Email already registered');
    if (phone && (await this.users.findOne({ where: { phone } }))) throw new ConflictException('Phone already registered');
    return this.ds.transaction(async (em) => {
      const user = await em.save(
        em.create(User, {
          type: UserType.CUSTOMER,
          status: UserStatus.ACTIVE,
          email,
          phone,
          firstName: input.firstName,
          lastName: input.lastName,
          language: input.language ?? 'en',
          passwordHash: input.password ? await this.hash(input.password) : null,
          phoneVerified: !!input.phoneVerified,
          emailVerified: !!input.emailVerified,
          googleId: input.googleId ?? null,
          appleId: input.appleId ?? null,
        }),
      );
      const consent = !!(input.marketingEmailConsent || input.marketingSmsConsent);
      let referredById: string | null = null;
      if (input.referralCode) {
        const ref = await em.findOne(CustomerProfile, { where: { referralCode: input.referralCode.toUpperCase() } });
        if (ref) referredById = ref.userId;
      }
      await em.save(
        em.create(CustomerProfile, {
          userId: user.id,
          referralCode: await this.uniqueReferralCode(),
          referredById,
          marketingEmailConsent: !!input.marketingEmailConsent,
          marketingSmsConsent: !!input.marketingSmsConsent,
          marketingConsentAt: consent ? new Date() : null,
        }),
      );
      if (referredById) {
        await em.save(
          em.create(Referral, {
            referrerId: referredById,
            refereeId: user.id,
            referrerReward: this.settings.get('marketing.referralReferrerReward', 10),
            refereeReward: this.settings.get('marketing.referralRefereeReward', 10),
          }),
        );
      }
      return user;
    });
  }

  async registerCustomer(dto: CustomerRegisterDto, ctx: ReqCtx) {
    const user = await this.createCustomer(dto);
    return this.completeLogin(user, ctx);
  }

  /** The id_token must have been issued for OUR app (otherwise a token minted for any other Google/Apple app would log in here). */
  private assertSocialAudience(provider: 'google' | 'apple', aud: unknown) {
    const allowed = this.config.get<string[]>(provider === 'google' ? 'social.googleClientIds' : 'social.appleClientIds') ?? [];
    if (!allowed.length) {
      if (this.config.get('env') === 'production') throw new UnauthorizedException('Social sign-in is not configured');
      this.logger.warn(`${provider} sign-in accepted without audience check (set ${provider.toUpperCase()}_CLIENT_IDS) - development only`);
      return;
    }
    const auds = Array.isArray(aud) ? aud : [aud];
    if (!auds.some((a) => typeof a === 'string' && allowed.includes(a))) throw new UnauthorizedException('Invalid token audience');
  }

  async socialLogin(dto: SocialLoginDto, ctx: ReqCtx) {
    let sub: string;
    let email: string | undefined;
    let first = dto.firstName ?? '';
    let last = dto.lastName ?? '';
    if (dto.provider === 'google') {
      const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(dto.idToken)}`);
      if (!res.ok) throw new UnauthorizedException('Invalid Google token');
      const info: any = await res.json();
      this.assertSocialAudience('google', info.aud);
      sub = info.sub;
      email = info.email_verified === 'true' || info.email_verified === true ? info.email : undefined;
      first = first || info.given_name || '';
      last = last || info.family_name || '';
    } else {
      try {
        const { payload } = await jwtVerify(dto.idToken, this.appleJwks, { issuer: 'https://appleid.apple.com' });
        this.assertSocialAudience('apple', payload.aud);
        sub = payload.sub as string;
        const ev = (payload as any).email_verified;
        email = ev === true || ev === 'true' ? (payload as any).email : undefined;
      } catch (e) {
        if (e instanceof UnauthorizedException) throw e;
        throw new UnauthorizedException('Invalid Apple token');
      }
    }
    const col = dto.provider === 'google' ? 'googleId' : 'appleId';
    let user = await this.users.findOne({ where: { [col]: sub } as any });
    if (!user && email) {
      user = await this.users.findOne({ where: { email: email.toLowerCase() } });
      if (user) await this.users.update(user.id, { [col]: sub } as any);
    }
    if (!user) {
      user = await this.createCustomer({ email, firstName: first, lastName: last, referralCode: dto.referralCode, emailVerified: !!email, [col]: sub } as any);
    }
    if (user.type !== UserType.CUSTOMER) throw new ForbiddenException('Social sign-in is for customers only');
    return this.completeLogin(user, ctx);
  }

  // ------------------------------------------------------------------ driver sign-up (PDF 5.1 step 1)
  async registerDriver(dto: DriverRegisterDto, ctx: ReqCtx) {
    const phone = this.normalizePhone(dto.phone);
    const email = dto.email.toLowerCase();
    await this.consumeOtp(phone, 'SIGNUP', dto.otpCode);
    if (await this.users.findOne({ where: { email } })) throw new ConflictException('Email already registered');
    if (await this.users.findOne({ where: { phone } })) throw new ConflictException('Phone already registered');
    const city = await this.ds.getRepository(City).findOne({ where: { id: dto.cityId } });
    if (!city) throw new BadRequestException('Unknown city');
    // the local zone the courier signed up from: it is switched on for them when their account is approved
    let registrationZoneId: string | null = null;
    if (dto.zoneId) {
      const zone = await this.ds.getRepository(Zone).findOne({ where: { id: dto.zoneId } });
      if (!zone || !zone.active) throw new BadRequestException('Unknown zone');
      if (zone.cityId !== dto.cityId) throw new BadRequestException('That zone is not in the chosen city');
      registrationZoneId = zone.id;
    }
    const { user, profileId } = await this.ds.transaction(async (em) => {
      const u = await em.save(
        em.create(User, {
          type: UserType.DRIVER,
          status: UserStatus.ACTIVE, // can log in to finish onboarding; cannot go online until DriverStatus is ACTIVE
          email,
          phone,
          phoneVerified: true,
          firstName: dto.firstName,
          lastName: dto.lastName,
          language: dto.language ?? 'en',
          passwordHash: await this.hash(dto.password),
        }),
      );
      const profile = await em.save(
        em.create(DriverProfile, {
          userId: u.id,
          cityId: dto.cityId,
          status: DriverStatus.APPLIED,
          vehicleType: dto.vehicleType,
          vehicleMake: dto.vehicleMake ?? null,
          vehicleModel: dto.vehicleModel ?? null,
          vehicleColor: dto.vehicleColor ?? null,
          licensePlate: dto.licensePlate ?? null,
          meta: registrationZoneId ? { registrationZoneId } : {},
        }),
      );
      return { user: u, profileId: profile.id };
    });
    await this.audit.log({ actor: { id: user.id, email, type: UserType.DRIVER }, action: 'driver.apply', entity: 'user', entityId: user.id, ip: ctx.ip });
    // the Super Admin's registration policy decides what happens next: active at once (instant), the staff queue (manual) or the Certn check (automatic)
    const verification = await this.requestVerification('DRIVER', profileId);
    // a courier on a zone's waiting list is not a staff task yet: they are invited when a place opens
    if (!verification?.waitlisted) this.notifications.notifyOps(verification?.mode === VerificationMethod.INSTANT ? 'driver.instant_activated' : 'driver.applied', { name: `${dto.firstName} ${dto.lastName}` }, { userId: user.id }).catch(() => undefined);
    return { ...(await this.completeLogin(user, ctx)), verification };
  }

  /**
   * Hands a new driver / business to the verification flow and returns what the app should tell the person (null when the flow is
   * unavailable: the account then simply waits in the manual queue). Goes through an event so that the auth layer does not depend on
   * the drivers and restaurants modules.
   */
  private async requestVerification(audience: 'DRIVER' | 'BUSINESS', id: string) {
    try {
      const answers: any[] = await this.events.emitAsync(Events.VERIFICATION_SUBJECT_REGISTERED, { audience, id } as SubjectRegisteredEvent);
      const r = answers.find((a) => a && typeof a === 'object' && a.mode);
      return r ? { mode: r.mode as VerificationMethod, accountStatus: r.accountStatus as string, waitlisted: !!r.waitlisted, ...r.verification } : null;
    } catch (e: any) {
      this.logger.error(`verification of the new ${audience} ${id} failed: ${e.message}`);
      return null;
    }
  }

  // ------------------------------------------------------------------ restaurant application (PDF 4.2 step 1)
  async applyRestaurant(dto: RestaurantApplyDto, ctx: ReqCtx) {
    const email = dto.email.toLowerCase();
    const phone = this.normalizePhone(dto.phone);
    if (await this.users.findOne({ where: { email } })) throw new ConflictException('Email already registered');
    if (await this.users.findOne({ where: { phone } })) throw new ConflictException('Phone already registered');
    const result = await this.ds.transaction(async (em) => {
      const user = await em.save(
        em.create(User, {
          type: UserType.RESTAURANT,
          status: UserStatus.ACTIVE,
          email,
          phone,
          firstName: dto.ownerFirstName,
          lastName: dto.ownerLastName,
          passwordHash: await this.hash(dto.password),
        }),
      );
      const merchant = await em.save(
        em.create(Merchant, { businessName: dto.businessName, legalName: dto.legalName ?? null, hstNumber: dto.hstNumber ?? null, contactEmail: email, contactPhone: phone }),
      );
      let slug = slugify(dto.restaurantName) || 'restaurant';
      if (await em.findOne(Restaurant, { where: { slug } })) slug = `${slug}-${randomBytes(2).toString('hex')}`;
      const cuisines = dto.cuisineIds?.length ? await em.find(Cuisine, { where: { id: In(dto.cuisineIds) } }) : [];
      const restaurant = await em.save(
        em.create(Restaurant, {
          merchantId: merchant.id,
          name: dto.restaurantName,
          slug,
          description: dto.description ?? null,
          phone,
          email,
          addressLine1: dto.addressLine1,
          addressLine2: dto.addressLine2 ?? null,
          city: dto.city,
          province: dto.province ?? 'ON',
          postalCode: dto.postalCode,
          lat: dto.lat ?? null,
          lng: dto.lng ?? null,
          cityId: dto.cityId ?? null,
          hstNumber: dto.hstNumber ?? null,
          ...storeTypeDefaults((dto.storeType as StoreType | undefined) ?? StoreType.RESTAURANT),
          status: RestaurantStatus.APPLIED,
          acceptingOrders: false,
          deliveryEnabled: dto.deliveryEnabled ?? true,
          pickupEnabled: dto.pickupEnabled ?? true,
          cuisines,
        }),
      );
      await em.save(em.create(RestaurantMember, { userId: user.id, merchantId: merchant.id, restaurantId: null, role: RestaurantRole.OWNER }));
      return { user, merchant, restaurant };
    });
    await this.audit.log({ actor: { id: result.user.id, email, type: UserType.RESTAURANT }, action: 'restaurant.apply', entity: 'restaurant', entityId: result.restaurant.id, ip: ctx.ip });
    // the Super Admin's registration policy decides what happens next: live at once (instant), the staff queue (manual) or the Certn check (automatic)
    const verification = await this.requestVerification('BUSINESS', result.restaurant.id);
    this.notifications.notifyOps(verification?.mode === VerificationMethod.INSTANT ? 'restaurant.instant_activated' : 'restaurant.applied', { name: dto.restaurantName }, { restaurantId: result.restaurant.id }).catch(() => undefined);
    // owners must enrol in 2FA when enforced, so route through login rules
    if (await this.needs2fa(result.user)) return { requires2faSetup: true, tempToken: this.accessToken(result.user, { pending2fa: true }), restaurantId: result.restaurant.id, verification };
    return { ...(await this.completeLogin(result.user, ctx)), restaurantId: result.restaurant.id, verification };
  }

  // ------------------------------------------------------------------ misc
  me(authUser: AuthUser) {
    return this.users.findOne({ where: { id: authUser.id } }).then(async (u) => ({
      ...(await this.publicUser(u!)),
      ...(authUser.impersonatedBy ? { impersonatedBy: authUser.impersonatedBy } : {}),
    }));
  }

  /**
   * Admin "open restaurant panel": short-lived access token (no refresh token, no session) for the
   * restaurant's OWNER (fallback: any active member) carrying `imp` = admin id. Blocked from
   * password/2FA/account-security routes via @NoImpersonation().
   */
  async impersonateRestaurant(restaurantId: string, admin: AuthUser, ctx: ReqCtx) {
    const restaurant = await this.ds.getRepository(Restaurant).findOne({ where: { id: restaurantId } });
    if (!restaurant) throw new NotFoundException('Restaurant not found');
    const members = await this.ds
      .getRepository(RestaurantMember)
      .createQueryBuilder('m')
      .where('m.merchantId = :mid AND m.active = true', { mid: restaurant.merchantId })
      .andWhere('(m.restaurantId IS NULL OR m.restaurantId = :rid)', { rid: restaurant.id })
      .getMany();
    const ordered = [...members].sort((a, b) => Number(b.role === RestaurantRole.OWNER) - Number(a.role === RestaurantRole.OWNER));
    let target: User | null = null;
    let member: RestaurantMember | null = null;
    for (const m of ordered) {
      const u = await this.users.findOne({ where: { id: m.userId } });
      if (u && u.type === UserType.RESTAURANT && u.status === UserStatus.ACTIVE) {
        target = u;
        member = m;
        break;
      }
    }
    if (!target || !member) throw new BadRequestException('This restaurant has no active owner or staff account to open a panel as. Add a member first.');
    const ttl = 60 * 60; // 1 h, no refresh token
    const accessToken = this.jwt.sign({ sub: target.id, type: target.type, tv: target.tokenVersion ?? 0, imp: admin.id } as JwtPayload, { expiresIn: ttl });
    await this.audit.log({
      actor: admin,
      action: 'restaurant.impersonate',
      entity: 'Restaurant',
      entityId: restaurant.id,
      after: { restaurantName: restaurant.name, targetUserId: target.id, targetEmail: target.email, targetRole: member.role, expiresInSeconds: ttl },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      path: '/admin/restaurants/' + restaurant.id + '/impersonate',
      method: 'POST',
    });
    const user = { ...(await this.publicUser(target)), impersonatedBy: admin.id };
    return { accessToken, expiresIn: ttl, restaurantId: restaurant.id, restaurantName: restaurant.name, user, impersonatedBy: { id: admin.id, email: admin.email, name: admin.name } };
  }

  async updateProfile(userId: string, dto: { firstName?: string; lastName?: string; avatarUrl?: string; language?: string }) {
    const patch: Partial<User> = {};
    for (const k of ['firstName', 'lastName', 'avatarUrl', 'language'] as const) if (dto[k] !== undefined) (patch as any)[k] = dto[k];
    await this.users.update(userId, patch);
    this.strategy.invalidate(userId);
    return this.me({ id: userId } as AuthUser);
  }
}
