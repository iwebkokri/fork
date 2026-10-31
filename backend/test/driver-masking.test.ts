/**
 * Unit tests for what a courier sees of their own SIN and bank account (no server, no database):
 *
 *   cd backend && npx ts-node --transpile-only test/driver-masking.test.ts
 *
 * Only the last four digits of a SIN may be shown; a record that kept only three digits (older ones) still shows those three.
 * Prints PASS / FAIL per check and exits 1 on any FAIL.
 */
import { maskAccount, maskSin } from '../src/drivers/drivers.util';

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : detail ? `  -> ${detail}` : ''}`);
  if (!ok) failed++;
};

check('SIN 123 456 789 -> only the last four digits show', maskSin({ sinLast3: '789', sinLast4: '6789' }) === '***-**6-789', String(maskSin({ sinLast3: '789', sinLast4: '6789' })));
check('the masked SIN never contains the first five digits', !/12345/.test(maskSin({ sinLast3: '789', sinLast4: '6789' }) ?? ''));
check('an older record with three digits still shows those three', maskSin({ sinLast3: '318' }) === '***-***-318');
check('no SIN saved -> nothing to show', maskSin(null) === null && maskSin({}) === null);
check('a malformed last-four value falls back to the last three', maskSin({ sinLast4: 'abcd', sinLast3: '123' }) === '***-***-123');
check('bank account shows the last four digits only', maskAccount('1234567') === '****4567');
check('no bank account -> nothing to show', maskAccount(null) === null);

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
