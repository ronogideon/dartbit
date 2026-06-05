// Unified SMS gateway layer. Dispatches send/balance to the right provider (BlessedTexts or
// TalkSasa) based on:
//   - The tenant's own gateway config (NotificationConfig.gateway=CUSTOM + provider), OR
//   - The Dartbit platform default provider (PlatformSetting "sms_default_provider"), with creds
//     from env.
// This is the single entry point the rest of the app should use for SMS.
import prisma from './prisma';
import {
  sendSms as sendSmsBlessed, getSmsBalance as getBalanceBlessed,
  decryptApiKey, normalizeKenyanPhone, type SmsCreds, type SendSmsResult,
} from './blessedtexts';
import { sendSmsTalkSasa, getSmsBalanceTalkSasa } from './talksasa';

export type SmsProvider = 'BLESSEDTEXTS' | 'TALKSASA';

// The Dartbit platform default provider. Stored in PlatformSetting; falls back to env then TalkSasa.
const PROVIDER_SETTING_KEY = 'sms_default_provider';
let cachedDefaultProvider: SmsProvider | null = null;

export async function getDefaultProvider(): Promise<SmsProvider> {
  if (cachedDefaultProvider) return cachedDefaultProvider;
  try {
    const s = await prisma.platformSetting.findUnique({ where: { key: PROVIDER_SETTING_KEY } });
    if (s?.value === 'BLESSEDTEXTS' || s?.value === 'TALKSASA') {
      cachedDefaultProvider = s.value as SmsProvider;
      return cachedDefaultProvider;
    }
  } catch { /* ignore */ }
  const envP = (process.env.SMS_DEFAULT_PROVIDER || '').toUpperCase();
  cachedDefaultProvider = (envP === 'BLESSEDTEXTS' || envP === 'TALKSASA') ? envP as SmsProvider : 'TALKSASA';
  return cachedDefaultProvider;
}

export async function setDefaultProvider(p: SmsProvider): Promise<void> {
  await prisma.platformSetting.upsert({
    where: { key: PROVIDER_SETTING_KEY },
    create: { key: PROVIDER_SETTING_KEY, value: p },
    update: { value: p },
  });
  cachedDefaultProvider = p;
}

// Central Dartbit creds for a given provider, from env.
export function dartbitCredsFor(provider: SmsProvider): SmsCreds | null {
  if (provider === 'TALKSASA') {
    const apiKey = process.env.TALKSASA_API_TOKEN;
    const senderId = process.env.TALKSASA_SENDER_ID;
    if (!apiKey || !senderId) return null;
    return { apiKey, senderId };
  }
  // BLESSEDTEXTS
  const apiKey = process.env.BLESSEDTEXTS_API_KEY;
  const senderId = process.env.BLESSEDTEXTS_SENDER_ID;
  if (!apiKey || !senderId) return null;
  return { apiKey, senderId };
}

export interface ResolvedGateway {
  provider: SmsProvider;
  creds: SmsCreds;
  usesDartbit: boolean; // true = Dartbit shared gateway (wallet applies); false = tenant's own
}

// Resolve which gateway a tenant should use to SEND. Tenant's own (CUSTOM) creds take priority;
// otherwise the Dartbit default provider + env creds.
export async function resolveGateway(tenantId: string): Promise<ResolvedGateway | null> {
  const cfg = await prisma.notificationConfig.findUnique({ where: { tenantId } });
  if (cfg && cfg.gateway === 'CUSTOM' && cfg.apiKey && cfg.senderId) {
    const provider: SmsProvider = (cfg.provider === 'TALKSASA' || cfg.provider === 'BLESSEDTEXTS') ? cfg.provider as SmsProvider : 'BLESSEDTEXTS';
    try {
      return { provider, creds: { apiKey: decryptApiKey(cfg.apiKey), senderId: cfg.senderId }, usesDartbit: false };
    } catch (e) {
      console.error('[sms] failed to decrypt tenant api key, falling back to dartbit:', e);
    }
  }
  const provider = await getDefaultProvider();
  const creds = dartbitCredsFor(provider);
  if (!creds) return null;
  return { provider, creds, usesDartbit: true };
}

// Send via a specific provider.
export async function sendViaProvider(provider: SmsProvider, creds: SmsCreds, phone: string, message: string): Promise<SendSmsResult> {
  if (provider === 'TALKSASA') return sendSmsTalkSasa(creds, phone, message);
  return sendSmsBlessed(creds, phone, message);
}

// Balance for a specific provider. TalkSasa returns null (no API).
export async function balanceViaProvider(provider: SmsProvider, creds: SmsCreds): Promise<{ ok: boolean; balance: number | null; raw: unknown }> {
  if (provider === 'TALKSASA') return getSmsBalanceTalkSasa(creds.apiKey);
  return getBalanceBlessed({ apiKey: creds.apiKey });
}

export { normalizeKenyanPhone };
