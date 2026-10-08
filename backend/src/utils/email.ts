// Transactional email via Resend. Mirrors utils/notifications.ts (SMS) so both
// channels record to the same Message table and the Messages tab shows either.
//
// Failure philosophy matches SMS: a missing API key logs and skips rather than
// throwing, so a tenant with no email configured still works. Callers that must
// never fail the request behind them use background().
import { Resend } from 'resend';
import prisma from './prisma';

type Category = 'WELCOME' | 'RECEIPT' | 'REMINDER' | 'EXPIRED' | 'SYSTEM' | 'MANUAL' | 'OTHER';

let client: Resend | null = null;
function resend(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  return (client ??= new Resend(key));
}

/** Platform sender. Tenant-domain senders land in stage 2. */
function platformFrom(): string {
  return process.env.EMAIL_FROM_PLATFORM || 'Dartbit <no-reply@dartbittech.com>';
}

export interface SendEmailArgs {
  /**
   * Owning tenant — the attempt is recorded in their Messages tab. null for platform mail
   * (superadmin alerts and resets): those are logged only, never written under a tenant,
   * or a superadmin alert would show up in that ISP's own message history.
   */
  tenantId: string | null;
  to: string;
  subject: string;
  html: string;
  text: string;
  category: Category;
  from?: string;
  replyTo?: string;
  /** Shows up in Resend's logs. Letters, numbers, _ and - only. */
  tag?: string;
  /**
   * Doubles as the Resend idempotency key (24h window) and the Message dedupKey.
   * ALWAYS prefix with tenantId — dedupKey is globally unique, so an unprefixed
   * key built from a tenant-scoped value would silently swallow another tenant's send.
   */
  dedupKey?: string;
  subscriberId?: string | null;
  username?: string | null;
}

export interface EmailResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  messageId?: string;
}

const looksLikeEmail = (s: string) => /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(s.trim());

export async function sendEmail(args: SendEmailArgs): Promise<EmailResult> {
  const { tenantId, subject, html, text, category, dedupKey, subscriberId, username } = args;
  const to = (args.to || '').trim().toLowerCase();

  if (!looksLikeEmail(to)) {
    return { ok: false, skipped: true, reason: 'no valid email address' };
  }

  // Dedup before spending an API call. Same rail as sendNotification(). Platform mail has no
  // Message row to dedup against, so it relies on Resend's idempotency key alone.
  if (dedupKey && tenantId) {
    const existing = await prisma.message.findUnique({ where: { dedupKey } }).catch(() => null);
    if (existing) return { ok: false, skipped: true, reason: 'duplicate', messageId: existing.id };
  }

  const r = resend();
  if (!r) {
    console.warn(`[email] RESEND_API_KEY is not set — skipping "${subject}" to ${to}`);
    return { ok: false, skipped: true, reason: 'RESEND_API_KEY is not set' };
  }

  let providerId: string | undefined;
  let errorMessage: string | undefined;
  let errorCode: string | undefined;

  try {
    const { data, error } = await r.emails.send(
      {
        from: args.from || platformFrom(),
        to,
        subject,
        html,
        text,
        replyTo: args.replyTo,
        tags: args.tag ? [{ name: 'type', value: args.tag }] : undefined,
      },
      dedupKey ? { idempotencyKey: dedupKey.slice(0, 256) } : undefined
    );
    if (error) {
      errorCode = error.name;
      errorMessage = error.message;
      console.error(`[email] Resend rejected "${subject}" to ${to}: ${error.name}: ${error.message}`);
    } else {
      providerId = data?.id;
    }
  } catch (e) {
    errorMessage = e instanceof Error ? e.message : String(e);
    console.error(`[email] send threw for "${subject}" to ${to}:`, errorMessage);
  }

  // Record the attempt either way, exactly as the SMS path does, so failures are
  // visible in the Messages tab instead of only in logs.
  let messageId: string | undefined;
  if (!tenantId) {
    console.log(`[email] platform "${subject}" to ${to}: ${providerId ? 'sent ' + providerId : 'FAILED ' + (errorMessage || '')}`);
    return providerId ? { ok: true } : { ok: false, reason: errorMessage || 'send failed' };
  }
  try {
    const row = await prisma.message.create({
      data: {
        type: 'EMAIL',
        recipient: to,
        body: text,
        status: providerId ? 'SENT' : 'FAILED',
        gateway: 'RESEND',
        gatewayMsgId: providerId || null,
        cost: 0,
        errorCode: errorCode || null,
        errorMessage: errorMessage || null,
        subscriberId: subscriberId || null,
        username: username || null,
        category,
        dedupKey: dedupKey || null,
        tenantId,
      },
      select: { id: true },
    });
    messageId = row.id;
  } catch (e) {
    // A unique-violation here means a concurrent send won the dedup race. Not an error.
    console.error('[email] could not record Message row:', e instanceof Error ? e.message : String(e));
  }

  return providerId
    ? { ok: true, messageId }
    : { ok: false, reason: errorMessage || 'send failed', messageId };
}

/** Fire-and-forget. A notification failure must never fail the request behind it. */
export function background(label: string, task: () => Promise<unknown>): void {
  task().catch((err) => console.error(`[email] ${label} failed:`, err));
}
