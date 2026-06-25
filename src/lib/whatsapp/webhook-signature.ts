import crypto from 'node:crypto'

/**
 * Verify the HMAC-SHA256 signature Meta attaches to webhook POSTs.
 *
 * Meta signs the raw request body with your App Secret and sends the
 * result in the `x-hub-signature-256: sha256=<hex>` header. Without
 * verification, anyone who knows our webhook URL can POST fabricated
 * status updates and drift broadcast counts arbitrarily.
 *
 * Reference:
 *   https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verify-payloads
 *
 * Contract:
 *   `META_APP_SECRET` is **required**. If it's missing we fail closed —
 *   every request is rejected until the operator configures the
 *   secret. A previous version fell open with a warning log, which is
 *   unsafe for a public template: anyone who forgets the env var would
 *   be running a fully spoofable webhook.
 *
 *   Multi-brand: a single CRM can receive from WABAs that belong to
 *   *different* Meta apps (e.g. AUGRA and Elas que Vendem), each signing
 *   with its own App Secret. `META_APP_SECRET` therefore accepts a
 *   comma-separated list; the signature is accepted if it matches ANY
 *   listed secret. A single value stays valid (the common case).
 */
export function verifyMetaWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
): boolean {
  const raw = process.env.META_APP_SECRET
  if (!raw) {
    console.error(
      '[webhook] META_APP_SECRET is not set — rejecting request. ' +
        'Configure the env var (Meta → App Settings → Basic → App Secret) ' +
        'to enable signature verification.',
    )
    return false
  }

  if (!signatureHeader) return false
  if (!signatureHeader.startsWith('sha256=')) return false

  const secrets = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const sigBuf = Buffer.from(signatureHeader)

  for (const secret of secrets) {
    const expected =
      'sha256=' +
      crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
    const expBuf = Buffer.from(expected)
    // timingSafeEqual throws on length mismatch — guard first.
    if (sigBuf.length !== expBuf.length) continue
    if (crypto.timingSafeEqual(sigBuf, expBuf)) return true
  }
  return false
}
