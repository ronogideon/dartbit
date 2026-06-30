import crypto from 'crypto';
import prisma from './prisma';
import { b2cPayout, normalizeBackendUrl, isB2cConfigured } from './daraja';

// Cadence → minimum gap between payouts. INSTANT pays out on the next scheduler tick (~1 min).
const CADENCE_MS: Record<string, number> = {
  INSTANT: 0,
  MIN15: 15 * 60_000,
  MIN30: 30 * 60_000,
  HOURLY: 60 * 60_000,
};

// Manual collection methods = Dartbit pools the customer's money and must pay it out to the tenant.
// DARAJA_API / KOPOKOPO_API tenants collect into their OWN shortcode, so there is nothing to disburse.
const POOLED_METHODS = ['TILL_MANUAL', 'PHONE_MANUAL'];

type CfgRow = {
  tenantId: string; method: string; cadence: string; enabled: boolean;
  payoutPhone: string | null; payoutTill: string | null; lastPayoutAt: Date | null;
};

// Run one disbursement sweep: for every pooled tenant whose cadence window has elapsed, batch all
// not-yet-paid-out collections into ONE B2C transfer (saving per-transaction fees) and send it.
export async function runDisbursements(): Promise<void> {
  if (!isB2cConfigured()) return;

  const cfgs = (await prisma.$queryRawUnsafe(
    `SELECT "tenantId", method,
            COALESCE("payoutCadence",'INSTANT') AS cadence,
            COALESCE("payoutEnabled", false)   AS enabled,
            "payoutPhone", "payoutTill", "lastPayoutAt"
     FROM "PaymentConfig" WHERE method = ANY($1)`,
    POOLED_METHODS,
  )) as CfgRow[];

  const now = Date.now();
  for (const c of cfgs) {
    try {
      if (!c.enabled) continue;
      const dest = c.payoutPhone || c.payoutTill;
      if (!dest) continue;                       // tenant hasn't nominated a payout destination yet
      const isPhone = !!c.payoutPhone;           // phone → BusinessPayment, till → BusinessPayBill
      const windowMs = CADENCE_MS[c.cadence] ?? 0;
      if (windowMs > 0 && c.lastPayoutAt && now - new Date(c.lastPayoutAt).getTime() < windowMs) continue;

      // All settled collections for this tenant that haven't been paid out yet.
      const txns = await prisma.mpesaTransaction.findMany({
        where: { tenantId: c.tenantId, status: 'PAID', OR: [{ payoutStatus: null }, { payoutStatus: 'PENDING' }] },
        select: { id: true, amount: true, netToTenant: true },
        take: 500,
      });
      if (txns.length === 0) continue;
      const gross = txns.reduce((s, t) => s + (t.netToTenant && t.netToTenant > 0 ? t.netToTenant : t.amount), 0);
      if (Math.round(gross) < 1) continue;

      const id = crypto.randomUUID();
      const resultUrl = `${normalizeBackendUrl()}/webhooks/b2c/result`;
      // Reserve the batch + claim the txns BEFORE calling Daraja so a crash can't double-pay.
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Disbursement" (id,"tenantId",amount,charge,status,destination,"isPhone","txCount","createdAt")
         VALUES ($1,$2,$3,0,'PROCESSING',$4,$5,$6,NOW())`,
        id, c.tenantId, Math.round(gross), dest, isPhone, txns.length,
      );
      await prisma.mpesaTransaction.updateMany({
        where: { id: { in: txns.map(t => t.id) } },
        data: { payoutStatus: 'PROCESSING', payoutRef: id },
      });

      try {
        const { conversationId } = await b2cPayout({
          amount: Math.round(gross), partyB: dest, isPhone, resultUrl,
          remarks: `Dartbit payout (${txns.length} collections)`,
        });
        await prisma.$executeRawUnsafe(`UPDATE "Disbursement" SET "conversationId"=$1 WHERE id=$2`, conversationId, id);
        await prisma.$executeRawUnsafe(`UPDATE "PaymentConfig" SET "lastPayoutAt"=NOW() WHERE "tenantId"=$1`, c.tenantId);
      } catch (sendErr) {
        // Daraja rejected the request — release the claim so the next sweep retries cleanly.
        await prisma.$executeRawUnsafe(
          `UPDATE "Disbursement" SET status='FAILED', "resultDesc"=$1, "paidAt"=NOW() WHERE id=$2`,
          (sendErr as Error).message.slice(0, 200), id,
        ).catch(() => {});
        await prisma.mpesaTransaction.updateMany({ where: { payoutRef: id }, data: { payoutStatus: 'PENDING', payoutRef: null } }).catch(() => {});
      }
    } catch (e) {
      console.error(`[disbursement] tenant ${c.tenantId} sweep error:`, e instanceof Error ? e.message : e);
    }
  }
}

// Daraja B2C result callback. Finalizes the batch + its collections and records the transaction cost.
export async function handleB2cResult(body: Record<string, unknown>): Promise<void> {
  const result = (body?.Result || {}) as Record<string, unknown>;
  const conversationId = (result.ConversationID || result.OriginatorConversationID) as string | undefined;
  if (!conversationId) return;
  const ok = Number(result.ResultCode) === 0;
  const desc = (result.ResultDesc as string) || null;

  const rp = (result.ResultParameters as { ResultParameter?: Array<{ Key: string; Value: unknown }> } | undefined)?.ResultParameter || [];
  const param = (k: RegExp) => rp.find(p => k.test(p.Key));
  const receipt = (param(/^TransactionReceipt$/)?.Value as string) || null;
  // Capture any transaction cost Daraja reports (key varies by setup; match anything with "Charge").
  const chargeP = rp.find(p => /charge/i.test(p.Key) && typeof p.Value === 'number');
  const charge = chargeP ? Number(chargeP.Value) : 0;

  const rows = (await prisma.$queryRawUnsafe(
    `SELECT id FROM "Disbursement" WHERE "conversationId"=$1 LIMIT 1`, conversationId,
  )) as Array<{ id: string }>;
  const d = rows[0];
  if (!d) return;

  await prisma.$executeRawUnsafe(
    `UPDATE "Disbursement" SET status=$1, charge=$2, "mpesaReceipt"=$3, "resultDesc"=$4, "paidAt"=NOW() WHERE id=$5`,
    ok ? 'PAID' : 'FAILED', charge, receipt, desc, d.id,
  );
  if (ok) {
    await prisma.mpesaTransaction.updateMany({ where: { payoutRef: d.id }, data: { payoutStatus: 'PAID', payoutAt: new Date() } });
  } else {
    // Release so the funds are retried on the next sweep.
    await prisma.mpesaTransaction.updateMany({ where: { payoutRef: d.id }, data: { payoutStatus: 'PENDING', payoutRef: null } });
  }
}
