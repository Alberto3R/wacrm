// Conversions API (CAPI) para anúncios Click-to-WhatsApp.
//
// Quando um lead que veio de um anúncio CTWA "converte" no CRM (ex.: entra
// no estágio "Raio-X agendado" ou "Ganho"), devolvemos o evento pra Meta
// pra ela otimizar o tráfego pago. A chave é o `ctwa_clid` capturado no
// webhook (Fase 2). Payload conforme a doc da Meta:
//   action_source: 'business_messaging', messaging_channel: 'whatsapp',
//   user_data: { ctwa_clid, whatsapp_business_account_id, ph(sha256) }

import crypto from 'node:crypto'
import { decrypt } from '@/lib/whatsapp/encryption'

const GRAPH = 'https://graph.facebook.com/v22.0'

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s.trim().toLowerCase()).digest('hex')
}

export async function fireConversion(params: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any
  accountId: string
  contactId: string
  eventName: string // 'Lead' | 'Schedule' | 'Purchase' | ...
  value?: number
  currency?: string
}): Promise<{ ok: boolean; reason?: string }> {
  const { supabase, accountId, contactId, eventName, value, currency } = params

  // 1. Config CAPI da conta
  const { data: cfg } = await supabase
    .from('meta_capi_config')
    .select('enabled, pixel_id, capi_token, test_event_code')
    .eq('account_id', accountId)
    .maybeSingle()
  if (!cfg?.enabled || !cfg.pixel_id || !cfg.capi_token) {
    return { ok: false, reason: 'capi_not_configured' }
  }

  // 2. ctwa_clid mais recente do contato — sem ele não há atribuição CTWA
  const { data: attr } = await supabase
    .from('lead_attribution')
    .select('ctwa_clid')
    .eq('contact_id', contactId)
    .not('ctwa_clid', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const ctwaClid = attr?.ctwa_clid as string | undefined
  if (!ctwaClid) return { ok: false, reason: 'no_ctwa_clid' }

  // 3. WABA da conta + telefone do contato (hash pra matching)
  const [{ data: wa }, { data: contact }] = await Promise.all([
    supabase.from('whatsapp_config').select('waba_id').eq('account_id', accountId).maybeSingle(),
    supabase.from('contacts').select('phone_normalized').eq('id', contactId).maybeSingle(),
  ])

  const userData: Record<string, unknown> = { ctwa_clid: ctwaClid }
  if (wa?.waba_id) userData.whatsapp_business_account_id = wa.waba_id
  if (contact?.phone_normalized) userData.ph = [sha256(contact.phone_normalized)]

  const event: Record<string, unknown> = {
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    action_source: 'business_messaging',
    messaging_channel: 'whatsapp',
    user_data: userData,
  }
  if (typeof value === 'number' && value > 0) {
    event.custom_data = { value, currency: currency ?? 'BRL' }
  }

  const body: Record<string, unknown> = { data: [event] }
  if (cfg.test_event_code) body.test_event_code = cfg.test_event_code

  let token: string
  try {
    token = decrypt(cfg.capi_token)
  } catch {
    return { ok: false, reason: 'token_decrypt_failed' }
  }

  try {
    const res = await fetch(
      `${GRAPH}/${cfg.pixel_id}/events?access_token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    )
    if (!res.ok) {
      console.error('[capi] erro Meta', res.status, await res.text())
      return { ok: false, reason: `meta_${res.status}` }
    }
    return { ok: true }
  } catch (err) {
    console.error('[capi] fetch falhou', err)
    return { ok: false, reason: 'fetch_failed' }
  }
}
