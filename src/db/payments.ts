import type { Client } from "@libsql/client";

export interface PaymentReceiptRecord {
  paymentId: string;
  endpoint: "upload" | "media";
  amountSats: number;
  quoteAmountSats: number;
  mintUrl: string;
  payerPubkey: string | null;
  uploaderPubkey: string | null;
  meltQuoteId: string | null;
  meltState: string | null;
  paidAt: number;
  createdAt: number;
}

export async function insertPaymentReceipt(
  db: Client,
  receipt: PaymentReceiptRecord,
): Promise<void> {
  await db.execute({
    sql: `INSERT OR REPLACE INTO payment_receipts
      (payment_id, endpoint, amount_sats, quote_amount_sats, mint_url, payer_pubkey, uploader_pubkey, melt_quote_id, melt_state, paid_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      receipt.paymentId,
      receipt.endpoint,
      receipt.amountSats,
      receipt.quoteAmountSats,
      receipt.mintUrl,
      receipt.payerPubkey,
      receipt.uploaderPubkey,
      receipt.meltQuoteId,
      receipt.meltState,
      receipt.paidAt,
      receipt.createdAt,
    ],
  });
}
