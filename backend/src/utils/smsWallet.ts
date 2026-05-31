// Per-tenant prepaid SMS wallet operations. Tenants top up via M-Pesa; each SMS sent through
// the Dartbit shared gateway debits the wallet at the configured per-SMS rate. The rate lives
// in PlatformSetting (key "sms_rate_per_sms") so it can change without a redeploy and be tuned
// as more SMS providers are added.
import prisma from './prisma';

const RATE_KEY = 'sms_rate_per_sms';
const DEFAULT_RATE = 0.45; // KES per SMS, default; overridable via PlatformSetting

// Get the current per-SMS charge rate (KES). Falls back to env then default.
export async function getSmsRate(): Promise<number> {
  try {
    const row = await prisma.platformSetting.findUnique({ where: { key: RATE_KEY } });
    if (row) {
      const n = Number(row.value);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  } catch { /* table may not exist yet on first boot */ }
  const envRate = Number(process.env.SMS_RATE_PER_SMS);
  return Number.isFinite(envRate) && envRate >= 0 ? envRate : DEFAULT_RATE;
}

export async function setSmsRate(rate: number): Promise<number> {
  const value = String(rate);
  await prisma.platformSetting.upsert({
    where: { key: RATE_KEY },
    create: { key: RATE_KEY, value },
    update: { value },
  });
  return rate;
}

// Get or create a tenant's wallet.
export async function getOrCreateWallet(tenantId: string) {
  let wallet = await prisma.smsWallet.findUnique({ where: { tenantId } });
  if (!wallet) {
    wallet = await prisma.smsWallet.create({ data: { tenantId, balance: 0, toppedUp: 0, spent: 0 } });
  }
  return wallet;
}

export async function getWalletBalance(tenantId: string): Promise<number> {
  const w = await prisma.smsWallet.findUnique({ where: { tenantId }, select: { balance: true } });
  return w?.balance ?? 0;
}

// Credit the wallet (top-up). Records a ledger entry. Idempotent on reference when provided
// (so a duplicate M-Pesa callback won't double-credit).
export async function creditWallet(tenantId: string, amount: number, reference?: string, note?: string) {
  if (amount <= 0) return null;
  if (reference) {
    const dup = await prisma.smsWalletTxn.findFirst({ where: { tenantId, type: 'TOPUP', reference } });
    if (dup) return dup; // already credited for this reference
  }
  return prisma.$transaction(async (tx) => {
    let wallet = await tx.smsWallet.findUnique({ where: { tenantId } });
    if (!wallet) wallet = await tx.smsWallet.create({ data: { tenantId, balance: 0, toppedUp: 0, spent: 0 } });
    const newBalance = wallet.balance + amount;
    await tx.smsWallet.update({
      where: { tenantId },
      data: { balance: newBalance, toppedUp: wallet.toppedUp + amount, lowBalanceAlerted: false },
    });
    return tx.smsWalletTxn.create({
      data: { walletId: wallet.id, tenantId, type: 'TOPUP', amount, balanceAfter: newBalance, reference: reference || null, note: note || 'SMS top-up' },
    });
  });
}

// Whether the tenant can afford to send `count` messages at the current rate. Tenants using
// their OWN gateway (CUSTOM) are not charged by Dartbit, so they always pass.
export async function canSend(tenantId: string, count = 1): Promise<{ ok: boolean; balance: number; rate: number; needed: number; usesDartbit: boolean }> {
  const cfg = await prisma.notificationConfig.findUnique({ where: { tenantId }, select: { gateway: true } });
  const usesDartbit = !cfg || cfg.gateway === 'DARTBIT';
  const rate = await getSmsRate();
  if (!usesDartbit) return { ok: true, balance: 0, rate, needed: 0, usesDartbit };
  const balance = await getWalletBalance(tenantId);
  const needed = rate * count;
  return { ok: balance >= needed, balance, rate, needed, usesDartbit };
}

// Debit the wallet for one (or more) SMS at the current rate. Only applies to Dartbit-gateway
// tenants. Records a ledger entry linked to the message. Returns the amount debited.
export async function debitForSms(tenantId: string, count = 1, messageRef?: string): Promise<number> {
  const cfg = await prisma.notificationConfig.findUnique({ where: { tenantId }, select: { gateway: true } });
  const usesDartbit = !cfg || cfg.gateway === 'DARTBIT';
  if (!usesDartbit) return 0;
  const rate = await getSmsRate();
  const amount = rate * count;
  if (amount <= 0) return 0;
  await prisma.$transaction(async (tx) => {
    let wallet = await tx.smsWallet.findUnique({ where: { tenantId } });
    if (!wallet) wallet = await tx.smsWallet.create({ data: { tenantId, balance: 0, toppedUp: 0, spent: 0 } });
    const newBalance = wallet.balance - amount;
    await tx.smsWallet.update({
      where: { tenantId },
      data: { balance: newBalance, spent: wallet.spent + amount },
    });
    await tx.smsWalletTxn.create({
      data: { walletId: wallet.id, tenantId, type: 'SMS_DEBIT', amount: -amount, balanceAfter: newBalance, reference: messageRef || null, note: 'SMS sent' },
    });
  });
  return amount;
}
