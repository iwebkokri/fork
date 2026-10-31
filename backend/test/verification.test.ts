/**
 * Unit tests for the registration / verification policy helpers (no server, no database):
 *
 *   cd backend && npx ts-node --transpile-only test/verification.test.ts
 *
 * Covers reading the policy from settings (including garbage values), the effective mode, Certn readiness, the override rule,
 * the text shown to accounts, the `meta` helpers and the settings definitions. Prints PASS / FAIL per check and exits 1 on any FAIL.
 */
import { DriverStatus, UserType, VerificationAudience as A, VerificationMethod as M, VerificationStatus } from '../src/common/enums';
import { MAX_CHECK_ATTEMPTS, DriverVerification } from '../src/verification/driver-verification';
import { VerificationService } from '../src/verification/verification.service';
import {
  BACKFILL_KEY,
  POLICY_KEYS,
  VERIFICATION_SETTING_DEFINITIONS,
  VERIFICATION_SETTING_GROUP,
  assertOverrideAllowed,
  certnStatus,
  deadlineText,
  describeMode,
  readPolicy,
  verificationSteps,
  verificationSummary,
  withoutRestore,
} from '../src/verification/verification-policy';

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : detail ? `  -> ${detail}` : ''}`);
  if (!ok) failed++;
};
const settings = (values: Record<string, any>) => ({ get: <T>(k: string, d?: T) => (k in values ? values[k] : d) as T });
const throws = (fn: () => void) => {
  try {
    fn();
    return null;
  } catch (e: any) {
    return e;
  }
};

// ---- policy -------------------------------------------------------------------------------------------------------------------
{
  const p = readPolicy(settings({}), A.DRIVER);
  check('default policy: not instant, manual, mode MANUAL (today\'s behaviour is unchanged until a Super Admin changes it)', !p.instant && p.method === M.MANUAL && p.mode === M.MANUAL);
}
{
  const p = readPolicy(settings({ [POLICY_KEYS.DRIVER.instant]: true, [POLICY_KEYS.DRIVER.method]: M.AUTOMATIC }), A.DRIVER);
  check('instant registration wins for new sign-ups but the method is kept (it is what force verification uses)', p.instant && p.method === M.AUTOMATIC && p.mode === M.INSTANT);
}
{
  const p = readPolicy(settings({ [POLICY_KEYS.BUSINESS.method]: M.AUTOMATIC }), A.BUSINESS);
  check('automatic without instant: mode AUTOMATIC', !p.instant && p.method === M.AUTOMATIC && p.mode === M.AUTOMATIC);
}
{
  const d = readPolicy(settings({ [POLICY_KEYS.DRIVER.instant]: true }), A.DRIVER);
  const b = readPolicy(settings({ [POLICY_KEYS.DRIVER.instant]: true }), A.BUSINESS);
  check('drivers and businesses are independent', d.instant && !b.instant);
}
{
  const garbage = readPolicy(settings({ [POLICY_KEYS.DRIVER.instant]: 'yes', [POLICY_KEYS.DRIVER.method]: 'INSTANT' }), A.DRIVER);
  check('garbage in the settings table means the safe default (not instant, manual)', !garbage.instant && garbage.method === M.MANUAL);
  const odd = readPolicy(settings({ [POLICY_KEYS.DRIVER.instant]: 1, [POLICY_KEYS.DRIVER.method]: null }), A.DRIVER);
  check('only the boolean true turns instant registration on', !odd.instant && odd.method === M.MANUAL);
}

// ---- settings definitions ------------------------------------------------------------------------------------------------------
{
  const keys = VERIFICATION_SETTING_DEFINITIONS.map((d) => d.key);
  check('four policy settings plus the internal backfill flag, all in the "verification" group (hidden from the generic Settings page)', keys.length === 5 && keys.includes(BACKFILL_KEY) && VERIFICATION_SETTING_DEFINITIONS.every((d) => d.group === VERIFICATION_SETTING_GROUP));
  check('every key of POLICY_KEYS has a definition', Object.values(POLICY_KEYS).every((k) => keys.includes(k.instant) && keys.includes(k.method)));
  check('defaults: instant false, method MANUAL', VERIFICATION_SETTING_DEFINITIONS.filter((d) => d.key.endsWith('.instant')).every((d) => d.value === false) && VERIFICATION_SETTING_DEFINITIONS.filter((d) => d.key.endsWith('.method')).every((d) => d.value === M.MANUAL));
}

// ---- Certn readiness -----------------------------------------------------------------------------------------------------------
{
  const dev = certnStatus({ NODE_ENV: 'development' });
  check('development without a key: the mock is ready', dev.ready && dev.mock && !dev.configured && dev.provider === 'certn-mock');
  const prod = certnStatus({ NODE_ENV: 'production' });
  check('production without a key: not ready, with a reason that names CERTN_API_KEY', !prod.ready && !prod.mock && /CERTN_API_KEY/.test(prod.reason ?? ''));
  const half = certnStatus({ NODE_ENV: 'production', CERTN_API_KEY: 'k' });
  check('production with a key but no webhook secret: not ready (results would be refused)', !half.ready && half.configured && /CERTN_WEBHOOK_SECRET/.test(half.reason ?? ''));
  const full = certnStatus({ NODE_ENV: 'production', CERTN_API_KEY: 'k', CERTN_WEBHOOK_SECRET: 's' });
  check('production with key and secret: ready, provider certn', full.ready && full.provider === 'certn' && !full.mock && full.reason === null);
  check('blank values count as not set', !certnStatus({ NODE_ENV: 'production', CERTN_API_KEY: '  ', CERTN_WEBHOOK_SECRET: 's' }).ready);
  const url = certnStatus({ NODE_ENV: 'production', CERTN_API_KEY: 'k', CERTN_WEBHOOK_SECRET: 's', PUBLIC_URL: 'https://api.example.ca/' });
  check('the webhook URL is derived from PUBLIC_URL (no double slash)', url.webhookUrl === 'https://api.example.ca/api/v1/public/webhooks/certn');
  const explicit = certnStatus({ NODE_ENV: 'production', CERTN_API_KEY: 'k', CERTN_WEBHOOK_SECRET: 's', PUBLIC_URL: 'https://api.example.ca', CERTN_WEBHOOK_URL: 'https://hooks.example.ca/c' });
  check('CERTN_WEBHOOK_URL wins over PUBLIC_URL', explicit.webhookUrl === 'https://hooks.example.ca/c');
  check('the secret value itself is never part of the status', !JSON.stringify(full).includes('"s"') && !('webhookSecretValue' in full));
}

// ---- override rule -------------------------------------------------------------------------------------------------------------
{
  const staff = throws(() => assertOverrideAllowed({ type: UserType.STAFF }, 'because'));
  check('a staff account cannot override the checklist (403)', staff?.getStatus?.() === 403);
  const noNote = throws(() => assertOverrideAllowed({ type: UserType.SUPER_ADMIN }, ' '));
  check('a Super Admin override needs a note (400)', noNote?.getStatus?.() === 400);
  check('a Super Admin override with a note is allowed', throws(() => assertOverrideAllowed({ type: UserType.SUPER_ADMIN }, 'verified by phone')) === null);
  check('no account at all is refused', throws(() => assertOverrideAllowed(null, 'x'))?.getStatus?.() === 403);
}

// ---- texts ---------------------------------------------------------------------------------------------------------------------
{
  const soon = new Date(Date.now() + 3 * 86400_000);
  check('deadlineText: a future deadline reads " by YYYY-MM-DD"', deadlineText(soon) === ` by ${soon.toISOString().slice(0, 10)}`);
  check('deadlineText: no deadline or one that is already now reads as nothing', deadlineText(null) === '' && deadlineText(new Date()) === '' && deadlineText(new Date(Date.now() - 1000)) === '');
  check('every mode has a description for both audiences', [M.INSTANT, M.MANUAL, M.AUTOMATIC].every((m) => describeMode(A.DRIVER, m).length > 20 && describeMode(A.BUSINESS, m).length > 20));
  check('the automatic description says nobody is rejected automatically', /nobody is rejected automatically/i.test(describeMode(A.DRIVER, M.AUTOMATIC)));
  check('steps differ by method and audience', verificationSteps(A.DRIVER, M.MANUAL) !== verificationSteps(A.BUSINESS, M.MANUAL) && /Certn/.test(verificationSteps(A.DRIVER, M.AUTOMATIC)) && verificationSteps(A.DRIVER, M.AUTOMATIC) === verificationSteps(A.BUSINESS, M.AUTOMATIC));
}
{
  const base = { verificationMethod: null as string | null, verificationDueAt: null as Date | null, verifiedAt: null as Date | null, backgroundCheckStatus: 'NOT_STARTED' };
  const verified = verificationSummary(A.DRIVER, { ...base, verificationStatus: 'VERIFIED' });
  check('summary: a verified account has nothing left to do', verified.status === 'VERIFIED' && verified.nextStep === null);
  const instant = verificationSummary(A.DRIVER, { ...base, verificationStatus: 'UNVERIFIED', verificationMethod: 'INSTANT' });
  check('summary: an unverified account is told it may be asked later', /not verified/.test(instant.nextStep ?? ''));
  const due = new Date(Date.now() + 5 * 86400_000);
  const manual = verificationSummary(A.BUSINESS, { ...base, verificationStatus: 'PENDING', verificationMethod: 'MANUAL', verificationDueAt: due });
  check('summary: a pending manual account is told to finish by the deadline', /reviewing your business/.test(manual.nextStep ?? '') && (manual.nextStep ?? '').includes(due.toISOString().slice(0, 10)));
  const auto = verificationSummary(A.DRIVER, { ...base, verificationStatus: 'PENDING', verificationMethod: 'AUTOMATIC', backgroundCheckStatus: 'IN_PROGRESS' });
  check('summary: an automatic account in progress is pointed to the Certn email', /Certn emailed you/.test(auto.nextStep ?? ''));
  const review = verificationSummary(A.DRIVER, { ...base, verificationStatus: 'NEEDS_REVIEW', verificationMethod: 'AUTOMATIC' });
  check('summary: needs-review does not say why (no result details leak to the account)', /closer look/.test(review.nextStep ?? '') && !/CONSIDER|FAILED|criminal/i.test(review.nextStep ?? ''));
}

// ---- meta helper ---------------------------------------------------------------------------------------------------------------
{
  const meta = { notes: 'x', verification: { restoreStatus: 'ACTIVE', restoreAccepting: true, blockedAt: 'now', forcedBy: 'u1', certnAttempts: 2 } };
  const cleared = withoutRestore(meta);
  check('withoutRestore clears the restore memory only', cleared.verification.restoreStatus === null && cleared.verification.restoreAccepting === null && cleared.verification.blockedAt === null && cleared.verification.forcedBy === 'u1' && cleared.verification.certnAttempts === 2 && cleared.notes === 'x');
  check('withoutRestore does not touch its input', meta.verification.restoreStatus === 'ACTIVE');
  const plain = { notes: 'x' };
  check('withoutRestore leaves meta without verification data alone (same object) and tolerates null', withoutRestore(plain) === plain && withoutRestore(null) === null && withoutRestore(undefined) === undefined);
}

// ---- the service and the driver handler with fakes: the paths a running mock Certn cannot reach ----------------------------------------
const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    await fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
};
const PROD_NO_CERTN = { NODE_ENV: 'production', CERTN_API_KEY: undefined, CERTN_WEBHOOK_SECRET: undefined };
const DEV = { NODE_ENV: 'development', CERTN_API_KEY: undefined };
const rejection = async (p: Promise<any>) => {
  try {
    await p;
    return null;
  } catch (e: any) {
    return e;
  }
};
const codeOf = (e: any) => e?.getResponse?.()?.code;

async function serviceTests() {
  const store: Record<string, any> = {};
  const forced: any[] = [];
  const settingsFake = { get: (k: string, d?: any) => (k in store ? store[k] : d), set: async (k: string, v: any) => void (store[k] = v) };
  const auditFake = { logReq: async () => undefined, log: async () => undefined };
  const handler = (audience: A, failRegistration = false) => ({
    audience,
    onRegistered: async () => {
      if (failRegistration) throw new Error('boom');
      return { mode: M.MANUAL, accountStatus: 'APPLIED', verification: {} };
    },
    forceTargets: async (ids?: string[]) => ({ targets: ids ?? [], skipped: [] }),
    force: async (id: string, o: any) => {
      forced.push([id, o]);
      return { id, name: 'x', outcome: 'GRACE' };
    },
  });
  const svc = new VerificationService(settingsFake as any, auditFake as any, handler(A.DRIVER, true) as any, handler(A.BUSINESS) as any);
  const actor: any = { id: 'u1', type: UserType.SUPER_ADMIN };

  await withEnv(PROD_NO_CERTN, async () => {
    const e = await rejection(svc.updatePolicy({ drivers: { method: M.AUTOMATIC } } as any, actor));
    check('automatic cannot be switched on while Certn is not configured (400, code CERTN_NOT_READY)', e?.getStatus?.() === 400 && codeOf(e) === 'CERTN_NOT_READY', String(e));
    check('...and nothing was saved', Object.keys(store).length === 0);
    const ok = await svc.updatePolicy({ drivers: { instant: true } } as any, actor);
    check('instant registration needs no Certn: it can be switched on', ok.drivers.instant === true && store[POLICY_KEYS.DRIVER.instant] === true);
    const f = await rejection(svc.force({ audience: A.DRIVER, all: true, method: M.AUTOMATIC } as any, actor));
    check('force with the automatic method is refused while Certn is not ready (400, CERTN_NOT_READY)', f?.getStatus?.() === 400 && codeOf(f) === 'CERTN_NOT_READY', String(f));
    const manual = await svc.force({ audience: A.DRIVER, all: true } as any, actor);
    check('force with the manual method needs no Certn', manual.method === M.MANUAL && manual.matched === 0);
  });
  await withEnv(DEV, async () => {
    await svc.updatePolicy({ businesses: { method: M.AUTOMATIC, instant: false } } as any, actor);
    check('with the mock provider (development) automatic can be switched on', store[POLICY_KEYS.BUSINESS.method] === M.AUTOMATIC && store[POLICY_KEYS.BUSINESS.instant] === false);
    const empty = await rejection(svc.updatePolicy({} as any, actor));
    check('an empty policy update is a 400', empty?.getStatus?.() === 400);
  });
  {
    const both = await rejection(svc.force({ audience: A.DRIVER, all: true, ids: ['a'] } as any, actor));
    const neither = await rejection(svc.force({ audience: A.DRIVER } as any, actor));
    check('force needs exactly one of ids / all', both?.getStatus?.() === 400 && neither?.getStatus?.() === 400);
  }
  {
    forced.length = 0;
    const r = await svc.force({ audience: A.BUSINESS, ids: ['m1', 'm2'], graceDays: 3 } as any, actor);
    const o = forced[0][1];
    check('force hands the method, the actor and a deadline graceDays from now to every account', r.matched === 2 && r.outcomes.GRACE === 2 && o.actor === actor && o.method === M.AUTOMATIC && Math.abs(o.dueAt.getTime() - (Date.now() + 3 * 86400_000)) < 5000, String(JSON.stringify(r.outcomes)));
    check('the first accounts of a batch start their Certn check at once, the batch is blocked inline when small', o.startCheckNow === true && o.blockNow === true);
    forced.length = 0;
    await svc.force({ audience: A.BUSINESS, ids: Array.from({ length: 60 }, (_, i) => `m${i}`) } as any, actor);
    check('a big batch starts only the first 20 checks inside the request and leaves blocking to the sweeper', forced.filter(([, x]) => x.startCheckNow).length === 20 && forced.every(([, x]) => x.blockNow === false));
  }
  {
    check('a failure while applying the registration policy never reaches the sign-up (answers null)', (await svc.onRegistered({ audience: 'DRIVER', id: 'p1' })) === null);
    check('...and a working handler answers with its result', (await svc.onRegistered({ audience: 'BUSINESS', id: 'r1' }))?.mode === M.MANUAL);
  }
}

function driverFixture(extra: Record<string, any> = {}) {
  const profile: any = {
    id: 'p1',
    userId: 'u1',
    status: DriverStatus.APPLIED,
    verificationStatus: VerificationStatus.PENDING,
    verificationMethod: null,
    cityId: 'c1',
    zoneIds: [],
    meta: {},
    backgroundCheckStatus: 'NOT_STARTED',
    backgroundCheckRef: null,
    user: { firstName: 'Ann', lastName: 'Lee', email: 'ann@example.com', phone: '+16475550100' },
    ...extra,
  };
  const calls = { changeStatus: [] as any[], opsNotify: [] as any[], certnStarts: 0 };
  const core: any = {
    getProfile: async () => profile,
    driverName: () => 'Ann Lee',
    requiredDocState: async () => [{ type: 'LICENCE', valid: false, status: null }],
    profiles: { save: async (p: any) => p, find: async () => [profile] },
    changeStatus: async (p: any, to: any, _actor: any, _reason: any, more: any = {}) => {
      calls.changeStatus.push([to, more]);
      p.status = to;
      Object.assign(p, more);
      return p;
    },
    // the real one also checks that the zone is still active and in the driver's city; the fake zones all qualify
    registrationZoneId: async (p: any) => p.meta?.registrationZoneId ?? null,
    waitlistIfFull: async () => false, // these tests are about the registration policy; the waiting list has its own test file
    sendWelcome: async () => undefined,
    notifyDriver: async () => undefined,
    opsNotify: async (...a: any[]) => void calls.opsNotify.push(a),
  };
  const certn: any = {
    start: async () => {
      calls.certnStarts++;
      throw new Error('Certn 503: service unavailable');
    },
  };
  const zones: any = { find: async () => [{ id: 'z1' }, { id: 'z2' }] };
  return { dv: new DriverVerification(core, {} as any, certn, { log: async () => undefined } as any, zones), profile, calls };
}

async function driverTests() {
  const pol = (v: Record<string, any>) => readPolicy(settings(v), A.DRIVER);
  {
    const { dv, profile, calls } = driverFixture();
    const r = await dv.onRegistered('p1', pol({ [POLICY_KEYS.DRIVER.instant]: true }));
    const [to, more] = calls.changeStatus[0] ?? [];
    check('instant: the driver is made ACTIVE with every active zone of the city, UNVERIFIED / INSTANT, and told so', r.mode === M.INSTANT && to === DriverStatus.ACTIVE && more.zoneIds.join() === 'z1,z2' && more.verificationStatus === VerificationStatus.UNVERIFIED && more.verificationMethod === M.INSTANT && profile.status === DriverStatus.ACTIVE && r.verification.status === 'UNVERIFIED', JSON.stringify(r));
  }
  {
    // a courier who signed up from a local zone starts with that zone, not with every zone of the city
    const { dv, calls } = driverFixture({ meta: { registrationZoneId: 'z2' } });
    await dv.onRegistered('p1', pol({ [POLICY_KEYS.DRIVER.instant]: true }));
    const [, more] = calls.changeStatus[0] ?? [];
    check('instant: a courier who signed up from a local zone starts with only that zone', more?.zoneIds?.join() === 'z2', JSON.stringify(more?.zoneIds));
  }
  await withEnv(PROD_NO_CERTN, async () => {
    const { dv, profile, calls } = driverFixture();
    const r = await dv.onRegistered('p1', pol({ [POLICY_KEYS.DRIVER.method]: M.AUTOMATIC }));
    check('automatic chosen but Certn not usable at sign-up: the application waits for staff (MANUAL) instead of failing, and says why', r.mode === M.MANUAL && profile.verificationMethod === M.MANUAL && profile.meta.verification.fallback === 'CERTN_NOT_READY' && calls.certnStarts === 0, JSON.stringify(profile.meta));
  });
  await withEnv(DEV, async () => {
    const { dv, profile, calls } = driverFixture();
    const r = await dv.onRegistered('p1', pol({ [POLICY_KEYS.DRIVER.method]: M.AUTOMATIC }));
    check('automatic with Certn failing at sign-up: the sign-up still succeeds, PENDING / AUTOMATIC, the failure is recorded', r.mode === M.AUTOMATIC && profile.verificationStatus === VerificationStatus.PENDING && profile.meta.verification.certnAttempts === 1 && /503/.test(profile.meta.verification.certnError) && calls.certnStarts === 1, JSON.stringify(profile.meta));
    for (let i = 0; i < MAX_CHECK_ATTEMPTS - 2; i++) await dv.retryChecks(10);
    check('the sweeper retries but does not give up early', profile.verificationStatus === VerificationStatus.PENDING && profile.meta.verification.certnAttempts === MAX_CHECK_ATTEMPTS - 1 && calls.opsNotify.length === 0, JSON.stringify(profile.meta));
    await dv.retryChecks(10);
    check(`after ${MAX_CHECK_ATTEMPTS} failed attempts the driver goes to staff (NEEDS_REVIEW) and staff are told once`, profile.verificationStatus === VerificationStatus.NEEDS_REVIEW && calls.opsNotify.length === 1 && /could not start/i.test(calls.opsNotify[0][1]), JSON.stringify(calls.opsNotify));
  });
  {
    const { dv } = driverFixture({ status: DriverStatus.ACTIVE, verificationStatus: VerificationStatus.PENDING, verificationMethod: M.MANUAL });
    const e = await rejection(dv.reject('p1', actorOf(), 'because'));
    check('reject only applies to drivers who are not working yet (400)', e?.getStatus?.() === 400, String(e));
    const v = await rejection(dv.verify('p1', { id: 'u', type: UserType.STAFF } as any, { override: true, note: 'x' }, pol({})));
    check('a staff account cannot use the override even when the checklist is open (403)', v?.getStatus?.() === 403, String(v));
    const open = await rejection(dv.verify('p1', { id: 'u', type: UserType.STAFF } as any, {}, pol({})));
    check('without the override an open checklist is a 400 with the code and one line per open item', open?.getStatus?.() === 400 && codeOf(open) === 'VERIFICATION_REQUIREMENTS_NOT_MET' && open.getResponse().details.length === 3, String(open));
  }
}
const actorOf = () => ({ id: 'u1', type: UserType.STAFF, name: 'Staff' }) as any;

Promise.resolve()
  .then(serviceTests)
  .then(driverTests)
  .catch((e) => {
    console.log(`FAIL  a service test crashed: ${e?.stack ?? e}`);
    failed++;
  })
  .finally(() => {
    console.log(failed ? `\n${failed} check(s) FAILED` : '\nall verification policy checks passed');
    process.exit(failed ? 1 : 0);
  });
