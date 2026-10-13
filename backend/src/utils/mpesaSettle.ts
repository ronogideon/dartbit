// M-Pesa payment settlement and recovery.
//
// A payment can reach "paid" four ways, and all of them go through settleTransaction():
//   1. Safaricom's callback (the normal path)
//   2. The STK status query — the backend asks Safaricom directly when no callback has arrived
//   3. Pull Transactions — the shortcode's own transaction history, for pushes we can't query
//   4. A staff "recheck" from the dashboard
//
// settleTransaction() claims the transaction atomically before doing anything, so a duplicate
// callback, a callback racing the status checker, or two server replicas can never extend an
// account twice or record a payment twice. A crash half-way through leaves the transaction in
// PROCESSING, and the checker picks it up again after a few minutes.
import prisma from './prisma';
import {
  centralDarajaCreds, decryptDarajaCreds, stkQuery, pullTransactions, PullUnavailableError, isAmbiguousPushError,
  type DarajaCreds, type PulledTransaction,
} from './daraja';

type Tx = NonNullable<Awaited<ReturnType<typeof prisma.mpesaTransaction.findUnique>>>;

export type Settlement =
  | { kind: 'paid'; receipt?: string | null; source: 'callback' | 'stk-query' | 'pull' | 'recheck' }
  | { kind: 'failed'; code: string; desc: string; source: 'callback' | 'stk-query' | 'timeout' };

export type SettleResult = 'settled' | 'already-paid' | 'in-progress' | 'not-pending' | 'recorded-failure' | 'error';

/** A PROCESSING transaction this old is assumed abandoned by a crash and may be retried. */
const STALE_PROCESSING_MS = 5 * 60_000;

/** Plain-language reasons for Safaricom's result codes, shown to customers and staff. */
export const NO_RESPONSE_DESC = 'No response from the phone (timed out)';
export function describeFailure(code: string, fallback: string): string {
  switch (String(code)) {
    case '1032': return 'Cancelled on the phone';
    case '1037': return NO_RESPONSE_DESC;
    case '1': return 'Insufficient M-Pesa balance';
    case '2001': return 'Wrong M-Pesa PIN';
    case '1019': return 'Payment request expired';
    case '1001': return 'Phone busy with another M-Pesa request — try again';
    case 'NO_CONFIRMATION': return 'M-Pesa never confirmed this payment';
    default: return fallback || `M-Pesa error ${code}`;
  }
}

/** The same credentials the push used: Dartbit's for centrally collected payments, else the tenant's. */
export async function credsForTransaction(tx: Pick<Tx, 'tenantId' | 'collectedVia' | 'purpose'>): Promise<DarajaCreds | null> {
  if (tx.collectedVia === 'DARTBIT' || tx.purpose === 'SMS_TOPUP') return centralDarajaCreds();
  const cfg = await prisma.paymentConfig.findUnique({ where: { tenantId: tx.tenantId } });
  return cfg ? decryptDarajaCreds(cfg) : null;
}

export async function settleTransaction(txId: string, s: Settlement): Promise<SettleResult> {
  if (s.kind === 'failed') {
    // Only a still-pending payment can fail. Never downgrade one that's paid or being set up.
    const r = await prisma.mpesaTransaction.updateMany({
      where: { id: txId, status: 'PENDING' },
      data: { status: 'FAILED', resultDesc: describeFailure(s.code, s.desc) },
    });
    if (r.count) console.log(`[mpesa] ${txId} FAILED via ${s.source}: ${s.code} ${s.desc}`);
    return r.count ? 'recorded-failure' : 'not-pending';
  }

  // Claim it. PENDING and FAILED can be claimed (a late, verified success beats an earlier
  // timeout); PROCESSING only once it's stale, meaning a previous attempt crashed.
  const receipt = (s.receipt || '').trim().toUpperCase() || null;
  const claim = await prisma.mpesaTransaction.updateMany({
    where: {
      id: txId,
      OR: [
        { status: 'PENDING' },
        { status: 'FAILED' },
        { status: 'PROCESSING', updatedAt: { lt: new Date(Date.now() - STALE_PROCESSING_MS) } },
      ],
    },
    data: { status: 'PROCESSING', resultDesc: 'Payment confirmed — setting up', ...(receipt ? { mpesaReceipt: receipt } : {}) },
  });
  if (!claim.count) {
    const cur = await prisma.mpesaTransaction.findUnique({ where: { id: txId }, select: { status: true } });
    if (cur?.status === 'PAID') return 'already-paid';
    if (cur?.status === 'PROCESSING') return 'in-progress';
    return 'not-pending';
  }

  const tx = await prisma.mpesaTransaction.findUnique({ where: { id: txId } });
  if (!tx) return 'error';
  const rcpt = receipt || tx.mpesaReceipt || '';
  console.log(`[mpesa] ${txId} PAID via ${s.source}${rcpt ? ` receipt=${rcpt}` : ' (no receipt yet)'}`);

  try {
    if (tx.purpose === 'SMS_TOPUP') {
      await settleTopup(tx, rcpt);
    } else {
      const { provisionFromTransaction } = await import('../routes/mpesa');
      await provisionFromTransaction(txId, rcpt);
    }
    const after = await prisma.mpesaTransaction.findUnique({ where: { id: txId }, select: { status: true } });
    if (after?.status !== 'PAID') {
      console.error(`[mpesa] ${txId} settled but still ${after?.status} — will retry`);
      return 'error';
    }
    return 'settled';
  } catch (e) {
    // Stays PROCESSING with the receipt saved. The checker retries once it's stale.
    console.error(`[mpesa] ${txId} provisioning failed after payment — will retry:`, e instanceof Error ? e.message : e);
    await prisma.mpesaTransaction.update({
      where: { id: txId },
      data: { resultDesc: 'Payment received — finishing setup' },
    }).catch(() => {});
    return 'error';
  }
}

async function settleTopup(tx: Tx, receipt: string) {
  // Credit first, mark PAID second: if we crash in between, the retry finds the credit already
  // there (checked against both possible references) and only marks it paid.
  const refs = [receipt, tx.id].filter(Boolean);
  const credited = await prisma.smsWalletTxn.findFirst({ where: { tenantId: tx.tenantId, type: 'TOPUP', reference: { in: refs } } });
  if (!credited) {
    const { creditWallet } = await import('./smsWallet');
    await creditWallet(tx.tenantId, tx.amount, receipt || tx.id, `SMS top-up • ${tx.phone || ''}`);
  }
  await prisma.mpesaTransaction.update({
    where: { id: tx.id },
    data: { status: 'PAID', mpesaReceipt: receipt || null, resultDesc: 'Success', fulfilledAt: new Date() },
  });
  try {
    const { recordExpense } = await import('../routes/expenses');
    await recordExpense({
      tenantId: tx.tenantId, amount: tx.amount, category: 'SMS', description: 'SMS wallet top-up',
      paymentMode: 'M-Pesa', reference: receipt || tx.id, source: 'AUTO',
    });
  } catch (e) {
    console.error('[mpesa] top-up expense record failed:', e instanceof Error ? e.message : e);
  }
}

/**
 * The STK push call threw. If Safaricom explicitly refused it, the payment failed. If we simply got
 * no answer (timeout, dropped connection), the prompt may be on the customer's phone right now —
 * keep it pending so their payment is still recognised when it lands.
 * Returns 'pending' when callers should tell the customer to check their phone.
 */
export async function recordPushFailure(txId: string, e: unknown): Promise<'pending' | 'failed'> {
  const msg = e instanceof Error ? e.message : 'STK failed';
  if (isAmbiguousPushError(e)) {
    await prisma.mpesaTransaction.update({ where: { id: txId }, data: { resultDesc: 'Waiting for M-Pesa confirmation' } }).catch(() => {});
    console.warn(`[mpesa] ${txId}: push outcome unknown (${msg}) — kept pending for the status checker`);
    return 'pending';
  }
  await prisma.mpesaTransaction.updateMany({ where: { id: txId, status: 'PENDING' }, data: { status: 'FAILED', resultDesc: msg } }).catch(() => {});
  return 'failed';
}

// ---------------------------------------------------------------------------------------------
// Transaction-history matching (Pull Transactions)

/** Shortcodes whose Daraja app can't use Pull Transactions; retried after a few hours. */
const pullOff = new Map<string, number>();
const pullCache = new Map<string, { at: number; from: number; rows: PulledTransaction[] }>();
const PULL_OFF_MS = 6 * 3600_000;
const PULL_CACHE_MS = 60_000;
const PULL_RECENT_MS = 6 * 3600_000;

export function pullAvailable(creds: DarajaCreds): boolean {
  return (pullOff.get(creds.shortcode) || 0) < Date.now();
}

async function pulledRows(creds: DarajaCreds, from: Date, to: Date): Promise<PulledTransaction[] | null> {
  if (!pullAvailable(creds)) return null;
  const now = Date.now();
  try {
    // One shared fetch of the recent window serves every pending payment on that shortcode.
    if (from.getTime() >= now - PULL_RECENT_MS) {
      const hit = pullCache.get(creds.shortcode);
      if (hit && now - hit.at < PULL_CACHE_MS && hit.from <= from.getTime()) return hit.rows;
      const recentFrom = new Date(now - PULL_RECENT_MS);
      const rows = await pullTransactions(creds, recentFrom, new Date(now));
      pullCache.set(creds.shortcode, { at: now, from: recentFrom.getTime(), rows });
      return rows;
    }
    return await pullTransactions(creds, from, to);
  } catch (e) {
    if (e instanceof PullUnavailableError) {
      pullOff.set(creds.shortcode, now + PULL_OFF_MS);
      console.warn(`[mpesa] transaction history unavailable for shortcode ${creds.shortcode} (${e.message}) — STK query only for ${PULL_OFF_MS / 3600_000}h`);
    } else {
      console.warn(`[mpesa] transaction history fetch failed for ${creds.shortcode}:`, e instanceof Error ? e.message : e);
    }
    return null;
  }
}

const alnum = (s: string) => s.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
const digits = (s: string) => s.replace(/\D/g, '');

/** Every form of a Kenyan number we might see: 2547..., 07..., 7... */
function phoneForms(p: string): string[] {
  const d = digits(p);
  if (!d) return [];
  const local = d.startsWith('254') ? d.slice(3) : d.startsWith('0') ? d.slice(1) : d;
  return [`254${local}`, `0${local}`, local];
}

/** Safaricom may mask the payer's number (e.g. 2547******123). Compare the visible parts. */
function msisdnMatches(pulled: string, txPhone: string): boolean {
  const p = pulled.replace(/[^0-9*]/g, '');
  if (!p || /^[0-9a-f]{40,}$/i.test(pulled.trim())) return false; // empty or hashed
  const forms = phoneForms(txPhone);
  if (!p.includes('*')) return forms.includes(p);
  const head = p.slice(0, p.indexOf('*'));
  const tail = p.slice(p.lastIndexOf('*') + 1);
  if (head.length + tail.length < 6) return false; // too little visible to be sure
  // The number of stars doesn't reliably equal the number of hidden digits ("2547 ***** 126",
  // "254708***430"), so compare only the visible start and end.
  return forms.some((f) => f.length >= head.length + tail.length && f.startsWith(head) && f.endsWith(tail));
}

/** The AccountReference values the push could have used (see each stkPush call site). */
async function accountRefsFor(tx: Tx): Promise<string[]> {
  const refs = new Set<string>(phoneForms(tx.phone).map(alnum));
  if (tx.purpose === 'SMS_TOPUP') refs.add('smswallet');
  const subId = tx.subscriberId;
  if (subId) {
    const sub = await prisma.subscriber.findUnique({ where: { id: subId }, select: { username: true } });
    if (sub?.username) refs.add(alnum(sub.username).slice(0, 12));
  }
  return [...refs].map((r) => r.slice(0, 12)).filter(Boolean);
}

/**
 * Find this payment in the shortcode's history. Conservative on purpose: amount must match, the
 * time must fit, the account reference or the phone must match, and the receipt must not already
 * belong to another payment. More than one candidate → nothing is assumed; it's logged instead.
 */
export async function findInHistory(tx: Tx, creds: DarajaCreds): Promise<{ receipt: string } | 'ambiguous' | null> {
  const start = tx.createdAt.getTime() - 2 * 60_000;
  const end = Math.min(Date.now(), tx.createdAt.getTime() + 30 * 60_000);
  const rows = await pulledRows(creds, new Date(start), new Date(end));
  if (!rows) return null;
  const refs = await accountRefsFor(tx);

  const candidates = rows.filter((r) => {
    if (Math.abs(r.amount - tx.amount) > 0.5) return false;
    if (r.at && (r.at.getTime() < start || r.at.getTime() > end)) return false;
    const refHit = !!r.billRef && refs.includes(alnum(r.billRef).slice(0, 12));
    return refHit || msisdnMatches(r.msisdn, tx.phone);
  });
  if (!candidates.length) return null;

  const unused: PulledTransaction[] = [];
  for (const c of candidates) {
    const used = await prisma.mpesaTransaction.findFirst({ where: { mpesaReceipt: c.receipt.toUpperCase(), NOT: { id: tx.id } }, select: { id: true } });
    if (!used) unused.push(c);
  }
  if (unused.length === 1) return { receipt: unused[0].receipt };
  if (unused.length > 1) {
    console.warn(`[mpesa] ${tx.id}: ${unused.length} possible matches in transaction history (${unused.map((u) => u.receipt).join(', ')}) — not auto-settling, needs review`);
    return 'ambiguous';
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Fulfilment: "paid" is not the same as "served".
//
// A payment is PAID once Safaricom confirms the money. It is FULFILLED (fulfilledAt set) only once
// the customer is actually served: expiry saved, RADIUS written, device reconnected, payment in the
// books. Provisioning sets fulfilledAt itself when every step succeeds; when any step fails it
// leaves it empty and ensureFulfilled() retries — from the background checker or a staff Recheck —
// until it sticks. Every step is safe to repeat: expiry is never shortened, the payment row is
// never duplicated, and reconnect commands are no-ops when the device is already online.

const MAC_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;
const SAFE_TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Router command that logs a paid hotspot device in, unless it's already online. The device's
 * CURRENT IP is looked up on the router (it may have changed since purchase); if the device isn't
 * on the hotspot at all, it does nothing. Works for RADIUS routers (the router sends this user and
 * password to RADIUS) and local-user routers alike. Values are validated: they end up in a script.
 */
export function hotspotLoginCommand(user: string, password: string, mac: string | null | undefined): string | null {
  const m = (mac || '').toUpperCase().trim();
  if (!MAC_RE.test(m) || !SAFE_TOKEN.test(user || '') || !SAFE_TOKEN.test(password || '')) return null;
  return ':delay 2s ; :if ([:len [/ip hotspot active find mac-address="' + m + '"]] = 0) do={ ' +
    ':local h [/ip hotspot host find mac-address="' + m + '"]; ' +
    ':if ([:len $h] > 0) do={ :local ip [/ip hotspot host get [:pick $h 0] address]; ' +
    ':do { /ip hotspot active login user=' + user + ' password=' + password + ' mac-address=' + m + ' ip=$ip } ' +
    'on-error={ :log warning "Dartbit: post-payment login failed for ' + user + '" } } }';
}

/** Payments created before this moment (first boot of v1.11.91) are left alone: they predate tracking. */
let fulfilSince: Date | null = null;
async function fulfilmentSince(): Promise<Date> {
  if (fulfilSince) return fulfilSince;
  const key = 'mpesa_fulfil_since';
  try {
    const row = await prisma.platformSetting.findUnique({ where: { key } });
    if (row?.value && !Number.isNaN(Date.parse(row.value))) return (fulfilSince = new Date(row.value));
    const now = new Date();
    await prisma.platformSetting.create({ data: { key, value: now.toISOString() } }).catch(() => {});
    return (fulfilSince = now);
  } catch {
    return new Date(); // can't read settings: be conservative, fulfil nothing old
  }
}

async function ensurePaymentRow(tx: Tx, subscriberId: string | null, notes: string): Promise<void> {
  const receipt = tx.mpesaReceipt || '';
  const refs = [receipt, tx.checkoutRequestId, tx.id].filter((r): r is string => !!r);
  const existing = await prisma.payment.findFirst({
    where: { tenantId: tx.tenantId, OR: [{ reference: { in: refs } }, ...(receipt ? [{ mpesaCode: receipt }] : [])] },
    select: { id: true },
  });
  if (existing) return;
  await prisma.payment.create({
    data: {
      amount: tx.amount, method: 'MPESA', source: 'AUTOMATIC',
      reference: receipt || tx.checkoutRequestId || tx.id, mpesaCode: receipt || null,
      notes, packageId: tx.packageId || null, subscriberId, tenantId: tx.tenantId,
    } as never,
  });
  console.log(`[mpesa] ${tx.id}: payment row was missing — recorded now`);
}

/** Did this subscriber get online at any point since paying? (decides whether lost time is restored) */
async function usedSince(subscriberId: string, since: Date): Promise<boolean> {
  const from = new Date(since.getTime() - 60_000);
  const [live, past] = await Promise.all([
    prisma.onlineSession.findFirst({ where: { subscriberId, startedAt: { gte: from } }, select: { subscriberId: true } }).catch(() => null),
    prisma.sessionRecord.findFirst({ where: { subscriberId, startedAt: { gte: from } }, select: { subscriberId: true } }).catch(() => null),
  ]);
  return !!(live || past);
}

export type FulfilOutcome = 'fulfilled' | 'not-paid' | 'retry';

/**
 * Make sure a PAID transaction actually served the customer, repairing whatever didn't happen.
 * Throws nothing: a failed step returns 'retry' and the checker tries again later.
 */
export async function ensureFulfilled(txId: string): Promise<FulfilOutcome> {
  const tx = await prisma.mpesaTransaction.findUnique({ where: { id: txId } });
  if (!tx || tx.status !== 'PAID') return 'not-paid';
  if (tx.fulfilledAt) return 'fulfilled';
  const done = async () => {
    await prisma.mpesaTransaction.update({ where: { id: txId }, data: { fulfilledAt: new Date() } });
    console.log(`[mpesa] ${txId}: customer served (fulfilment repaired)`);
    return 'fulfilled' as const;
  };

  try {
    if (tx.purpose === 'SMS_TOPUP') return await done(); // wallet credit happens before PAID

    const radius = await import('./radius');
    const radiusOn = radius.radiusConfigured();
    const { enqueueCommand } = await import('./commandQueue');
    const isOther = !tx.packageId && !!tx.notes;

    // ---- PPPoE / static renewal: expiry was saved before PAID (and is retried); repair RADIUS + unwall.
    if (tx.subscriberId) {
      const sub = await prisma.subscriber.findUnique({ where: { id: tx.subscriberId } });
      if (!sub) { console.warn(`[mpesa] ${txId}: subscriber ${tx.subscriberId} no longer exists — nothing to serve`); return await done(); }
      if (!isOther) {
        if (radiusOn) await radius.syncSubscriberToRadius(sub.id); // throws if RADIUS can't be written
        const entitled = sub.isActive && !!sub.expiresAt && sub.expiresAt > new Date();
        if (entitled && sub.service !== 'HOTSPOT' && sub.routerId) {
          const { enqueueUnwall } = await import('./walledGarden');
          await enqueueUnwall(sub.routerId, sub.username, sub.id, sub.ipAddress ?? null); // no-op unless walled
        }
      }
      await ensurePaymentRow(tx, sub.id, tx.notes ? `${tx.notes}${tx.phone ? ` — paid by ${tx.phone}` : ''}` : (tx.phone ? `Paid by ${tx.phone}` : ''));
      return await done();
    }

    // ---- Hotspot purchase: everything after the PAID mark may have been skipped.
    if (!tx.username) { console.warn(`[mpesa] ${txId}: paid hotspot purchase has no username — needs manual attention`); return 'retry'; }
    let sub = await prisma.subscriber.findFirst({ where: { tenantId: tx.tenantId, username: tx.username } });
    const mac = (tx.clientMac || '').toUpperCase() || null;
    let target = tx.expiresAt || new Date(tx.createdAt.getTime() + tx.durationMinutes * 60_000);

    // Our failure, not theirs: if they never got online since paying and a good chunk of the package
    // has already run out, restart the clock so they get the full time they paid for.
    const late = Date.now() - tx.createdAt.getTime() > Math.min(10 * 60_000, (tx.durationMinutes * 60_000) / 4);
    if (late && (!sub || !(await usedSince(sub.id, tx.createdAt)))) {
      const fresh = new Date(Date.now() + tx.durationMinutes * 60_000);
      if (fresh > target) {
        target = fresh;
        await prisma.mpesaTransaction.update({ where: { id: txId }, data: { expiresAt: target } });
        console.log(`[mpesa] ${txId}: never connected after paying — restarted ${tx.durationMinutes} min from now`);
      }
    }

    if (!sub) {
      sub = await prisma.subscriber.create({
        data: {
          tenantId: tx.tenantId, routerId: tx.routerId || undefined, packageId: tx.packageId || undefined,
          username: tx.username, secret: tx.password || '0000', fullName: tx.phone || 'Hotspot Customer',
          phone: tx.phone || null, service: 'HOTSPOT', isActive: true, expiresAt: target,
          macAddress: mac, ipAddress: tx.clientIp || null,
        },
      });
      console.log(`[mpesa] ${txId}: hotspot subscriber ${tx.username} was missing — created`);
    } else if (!sub.expiresAt || sub.expiresAt.getTime() < target.getTime() - 60_000 || !sub.isActive) {
      // Never shortens: only moves the expiry forward to what this payment bought.
      const newExpiry = sub.expiresAt && sub.expiresAt > target ? sub.expiresAt : target;
      sub = await prisma.subscriber.update({
        where: { id: sub.id },
        data: { expiresAt: newExpiry, isActive: true, packageId: tx.packageId || undefined, macAddress: sub.macAddress || mac },
      });
      console.log(`[mpesa] ${txId}: expiry for ${sub.username} repaired to ${newExpiry.toISOString()}`);
    }

    if (radiusOn) await radius.syncSubscriberToRadius(sub.id); // throws if RADIUS can't be written
    if (tx.routerId && sub.expiresAt && sub.expiresAt > new Date()) {
      const cmd = hotspotLoginCommand(sub.username, sub.secret, sub.macAddress || mac);
      if (cmd) await enqueueCommand(tx.routerId, cmd);
    }
    await ensurePaymentRow(tx, sub.id, `Hotspot • ${tx.phone || ''}`);
    return await done();
  } catch (e) {
    console.warn(`[mpesa] ${txId}: could not finish serving the customer yet (${e instanceof Error ? e.message : e}) — will retry`);
    return 'retry';
  }
}

// ---------------------------------------------------------------------------------------------
// Probing a single transaction

const lastProbe = new Map<string, number>();
const failedRetries = new Map<string, number>();
const MAX_PROVISION_RETRIES = 5;
const MAX_FULFIL_RETRIES = 30; // with the backoff below, roughly two days of attempts
const NO_CHECKOUT_GIVE_UP_MS = 2 * 3600_000;
const GIVE_UP_MS = 48 * 3600_000;

export type ProbeOutcome =
  | 'paid' | 'served' | 'failed' | 'pending' | 'already-paid' | 'in-progress' | 'not-pending'
  | 'no-credentials' | 'missing' | 'needs-review' | 'error';

/**
 * Work out what really happened to a payment and settle it. Safe to call any number of times, from
 * anywhere: the status checker, a customer's status poll, or a staff recheck.
 */
export async function probeTransaction(txId: string, source: 'sweep' | 'poll' | 'recheck' = 'sweep'): Promise<ProbeOutcome> {
  const tx = await prisma.mpesaTransaction.findUnique({ where: { id: txId } });
  if (!tx) return 'missing';
  lastProbe.set(txId, Date.now());
  const age = Date.now() - tx.createdAt.getTime();

  // A crash left it half-done: the payment is confirmed, only the setup needs finishing.
  if (tx.status === 'PROCESSING') {
    if (Date.now() - tx.updatedAt.getTime() < STALE_PROCESSING_MS) return 'in-progress';
    const n = (failedRetries.get(txId) || 0) + 1;
    failedRetries.set(txId, n);
    if (n > MAX_PROVISION_RETRIES && source === 'sweep') {
      if (n === MAX_PROVISION_RETRIES + 1) console.error(`[mpesa] ${txId}: payment confirmed but setup keeps failing — needs manual attention`);
      return 'needs-review';
    }
    const r = await settleTransaction(txId, { kind: 'paid', receipt: tx.mpesaReceipt, source: source === 'recheck' ? 'recheck' : 'stk-query' });
    if (r === 'settled') failedRetries.delete(txId);
    return r === 'settled' ? 'paid' : r === 'error' ? 'error' : (r as ProbeOutcome);
  }

  // Paid but the customer isn't served yet (expiry, RADIUS or reconnect failed): repair that.
  if (tx.status === 'PAID') {
    if (tx.fulfilledAt) return 'already-paid';
    if (tx.createdAt < (await fulfilmentSince())) return 'already-paid'; // predates tracking
    const n = (failedRetries.get(txId) || 0) + 1;
    failedRetries.set(txId, n);
    if (n > MAX_FULFIL_RETRIES && source === 'sweep') {
      if (n === MAX_FULFIL_RETRIES + 1) console.error(`[mpesa] ${txId}: paid but the customer still can't be served after ${MAX_FULFIL_RETRIES} tries — needs manual attention`);
      return 'needs-review';
    }
    const f = await ensureFulfilled(txId);
    if (f === 'fulfilled') { failedRetries.delete(txId); return 'served'; }
    return 'error';
  }

  const lateNoResponse = tx.status === 'FAILED' && tx.resultDesc === NO_RESPONSE_DESC;
  if (tx.status !== 'PENDING' && !lateNoResponse) return 'not-pending';

  const creds = await credsForTransaction(tx);
  if (!creds) return 'no-credentials';

  // A "no response from the phone" failure is occasionally followed by money actually leaving the
  // customer's account. Only the transaction history can show that, so that's all we check here.
  if (lateNoResponse) {
    const hit = await findInHistory(tx, creds);
    if (hit && hit !== 'ambiguous') {
      return (await settleTransaction(txId, { kind: 'paid', receipt: hit.receipt, source: 'pull' })) === 'settled' ? 'paid' : 'error';
    }
    return hit === 'ambiguous' ? 'needs-review' : 'not-pending';
  }

  if (tx.checkoutRequestId) {
    let q: Awaited<ReturnType<typeof stkQuery>>;
    try {
      q = await stkQuery(creds, tx.checkoutRequestId);
    } catch (e) {
      q = { state: 'pending', desc: e instanceof Error ? e.message : String(e) };
    }
    if (q.state === 'paid') {
      // STK query has no receipt number; pick it up from the history if it's available.
      const hit = await findInHistory(tx, creds).catch(() => null);
      const receipt = hit && hit !== 'ambiguous' ? hit.receipt : null;
      const r = await settleTransaction(txId, { kind: 'paid', receipt, source: source === 'recheck' ? 'recheck' : 'stk-query' });
      return r === 'settled' ? 'paid' : r === 'error' ? 'error' : (r as ProbeOutcome);
    }
    if (q.state === 'failed') {
      await settleTransaction(txId, { kind: 'failed', code: q.code, desc: q.desc, source: 'stk-query' });
      return 'failed';
    }
    // Still undecided at Safaricom. After a few minutes, see whether the money shows up anyway.
    if (age > 3 * 60_000) {
      const hit = await findInHistory(tx, creds);
      if (hit && hit !== 'ambiguous') {
        return (await settleTransaction(txId, { kind: 'paid', receipt: hit.receipt, source: 'pull' })) === 'settled' ? 'paid' : 'error';
      }
      if (hit === 'ambiguous') return 'needs-review';
    }
    if (age > GIVE_UP_MS) {
      await settleTransaction(txId, { kind: 'failed', code: 'NO_CONFIRMATION', desc: q.desc, source: 'timeout' });
      return 'failed';
    }
    return 'pending';
  }

  // No CheckoutRequestID: the push's response never reached us, so the status query is impossible.
  // If the prompt did reach the phone, the callback will still bring the ID; meanwhile the
  // transaction history is the only other way to see the payment.
  if (age > 2 * 60_000) {
    const hit = await findInHistory(tx, creds);
    if (hit && hit !== 'ambiguous') {
      return (await settleTransaction(txId, { kind: 'paid', receipt: hit.receipt, source: 'pull' })) === 'settled' ? 'paid' : 'error';
    }
    if (hit === 'ambiguous') return 'needs-review';
  }
  if (age > NO_CHECKOUT_GIVE_UP_MS) {
    await settleTransaction(txId, { kind: 'failed', code: 'NO_CONFIRMATION', desc: 'No confirmation from M-Pesa', source: 'timeout' });
    return 'failed';
  }
  return 'pending';
}

/**
 * Called from the customer/staff status polls. If a payment has been pending for a while, ask
 * Safaricom now instead of waiting for the next sweep — so the person watching the screen sees the
 * result in seconds. Throttled per transaction, and never holds the poll for more than 5 seconds.
 */
export async function probeIfStale(txId: string, status: string, createdAt: Date): Promise<void> {
  if (status !== 'PENDING' && status !== 'PROCESSING') return;
  if (Date.now() - createdAt.getTime() < 30_000) return; // give the callback its chance first
  if (Date.now() - (lastProbe.get(txId) || 0) < 15_000) return;
  lastProbe.set(txId, Date.now());
  await Promise.race([
    probeTransaction(txId, 'poll').catch((e) => console.warn(`[mpesa] poll probe ${txId}:`, e instanceof Error ? e.message : e)),
    new Promise((r) => setTimeout(r, 5_000)),
  ]);
}

// ---------------------------------------------------------------------------------------------
// The background checker

/** How long to wait between checks of one payment, by its age. Frequent at first, then backs off. */
function interval(ageMs: number): number {
  if (ageMs < 5 * 60_000) return 30_000;
  if (ageMs < 30 * 60_000) return 2 * 60_000;
  if (ageMs < 6 * 3600_000) return 10 * 60_000;
  return 30 * 60_000;
}

let sweeping = false;

export async function sweepPendingPayments(): Promise<{ checked: number; paid: number; failed: number; served: number }> {
  if (sweeping) return { checked: 0, paid: 0, failed: 0, served: 0 };
  sweeping = true;
  const stats = { checked: 0, paid: 0, failed: 0, served: 0 };
  try {
    const now = Date.now();
    const candidates = await prisma.mpesaTransaction.findMany({
      where: {
        OR: [
          { status: 'PENDING', createdAt: { lt: new Date(now - 45_000), gt: new Date(now - GIVE_UP_MS - 3600_000) } },
          { status: 'PROCESSING', updatedAt: { lt: new Date(now - STALE_PROCESSING_MS) } },
          // Recent "no response" failures, re-checked against the history (only if it's available).
          { status: 'FAILED', resultDesc: NO_RESPONSE_DESC, createdAt: { gt: new Date(now - 3 * 3600_000) } },
          // Paid, but the customer isn't served yet. Given a minute for provisioning to finish first.
          {
            status: 'PAID', fulfilledAt: null, updatedAt: { lt: new Date(now - 60_000) },
            createdAt: { gt: new Date(Math.max(now - GIVE_UP_MS, (await fulfilmentSince()).getTime())) },
          },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 60,
      select: { id: true, createdAt: true, status: true },
    });

    for (const c of candidates) {
      const age = now - c.createdAt.getTime();
      const wait = c.status === 'FAILED' ? 10 * 60_000 : c.status === 'PAID' ? Math.max(60_000, interval(age)) : interval(age);
      if (now - (lastProbe.get(c.id) || 0) < wait) continue;
      stats.checked++;
      try {
        const r = await probeTransaction(c.id, 'sweep');
        if (r === 'paid') stats.paid++;
        if (r === 'served') stats.served++;
        if (r === 'failed') stats.failed++;
      } catch (e) {
        console.warn(`[mpesa] sweep ${c.id}:`, e instanceof Error ? e.message : e);
      }
      await new Promise((r) => setTimeout(r, 300)); // gentle on Daraja
    }
    if (stats.paid || stats.failed || stats.served) console.log(`[mpesa] status check: ${stats.checked} checked, ${stats.paid} recovered as paid, ${stats.served} customers reconnected, ${stats.failed} confirmed failed`);
  } finally {
    sweeping = false;
    // Keep the throttle maps from growing forever.
    if (lastProbe.size > 5000) {
      const cutoff = Date.now() - 6 * 3600_000;
      for (const [k, v] of lastProbe) if (v < cutoff) lastProbe.delete(k);
    }
  }
  return stats;
}

export function startPaymentStatusChecker() {
  const tick = () => { sweepPendingPayments().catch((e) => console.error('[mpesa] status checker error:', e instanceof Error ? e.message : e)); };
  setTimeout(tick, 20_000); // let boot finish first
  setInterval(tick, 30_000);
}
