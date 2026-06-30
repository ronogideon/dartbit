import { Router, Request, Response } from 'express';
import express from 'express';
import prisma from '../utils/prisma';
import { verifyWebhookSignature } from '../utils/paystack';
import { markInvoicePaid } from './billing';

const router = Router();

// Paystack webhook. MUST receive the raw body to verify the HMAC signature,
// so this router uses express.raw() instead of the global JSON parser.
// Register in index.ts BEFORE app.use(express.json()) OR mount with its own raw parser (done here).
router.post('/paystack', express.raw({ type: '*/*' }), async (req: Request, res: Response) => {
  try {
    const signature = req.headers['x-paystack-signature'] as string;
    const rawBody = req.body instanceof Buffer ? req.body.toString('utf8') : JSON.stringify(req.body);

    if (!verifyWebhookSignature(rawBody, signature)) {
      console.warn('Paystack webhook: invalid signature');
      return res.status(401).send('Invalid signature');
    }

    const event = JSON.parse(rawBody);

    // Acknowledge immediately; Paystack retries on non-200.
    res.status(200).send('OK');

    if (event.event === 'charge.success') {
      const reference = event.data?.reference;
      if (!reference) return;
      const invoice = await prisma.tenantPayment.findUnique({ where: { paystackRef: reference } });
      if (invoice && invoice.status !== 'PAID') {
        await markInvoicePaid(invoice.id, invoice.tenantId, invoice.dueDate);
        console.log(`✅ Paystack webhook: invoice ${invoice.id} marked PAID`);
      }
    }
  } catch (err) {
    console.error('Paystack webhook error:', err instanceof Error ? err.message : err);
    // Already sent 200 in the success path; if we error before that, send 200 anyway
    if (!res.headersSent) res.status(200).send('OK');
  }
});

// Daraja B2C disbursement result + timeout. JSON-parsed locally (the global parser may not apply
// before this router). Always 200 so Daraja doesn't retry-storm.
router.post('/b2c/result', express.json({ type: '*/*' }), async (req: Request, res: Response) => {
  try {
    const { handleB2cResult } = await import('../utils/disbursement');
    await handleB2cResult(req.body || {});
  } catch (e) {
    console.error('[webhook] b2c result error:', e instanceof Error ? e.message : e);
  }
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

router.post('/b2c/timeout', express.json({ type: '*/*' }), async (_req: Request, res: Response) => {
  // Timeout means no definitive result yet; leave the batch PROCESSING for the result callback / retry.
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

export default router;
