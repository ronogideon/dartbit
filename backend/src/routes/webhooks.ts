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

export default router;
