import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'

// ============================================================
// POST /api/webhooks/gateway/[token] — webhook de gateway (Voomp etc.)
//
// O token na URL identifica a config (conta + funil + mapeamento de
// trigger→etapa). Cria/acha o contato, aplica a tag do produto e abre o
// negócio na etapa do evento. Idempotente por (config, pedido, trigger).
// Sempre responde 200 pra o gateway não re-tentar em loop.
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _admin: any = null
function admin() {
  if (!_admin) {
    _admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _admin
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isUnique(e: any) {
  return e?.code === '23505' || /duplicate key|unique/i.test(e?.message || '')
}
function str(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null
  if (typeof v === 'number') return String(v)
  return null
}
const ack = (reason: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ ok: false, reason, ...extra }, { status: 200 })

const DEFAULT_TAG_COLOR = '#A6E43C'

// find-or-create de tag (por nome, na conta) + vínculo no contato
async function tagContact(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  accountId: string,
  ownerId: string,
  contactId: string,
  tagName: string | null,
) {
  if (!tagName) return
  let tagId: string | null = null
  const { data: existing } = await db
    .from('tags')
    .select('id')
    .eq('account_id', accountId)
    .ilike('name', tagName)
    .maybeSingle()
  if (existing) {
    tagId = existing.id
  } else {
    const { data: created, error } = await db
      .from('tags')
      .insert({ account_id: accountId, user_id: ownerId, name: tagName, color: DEFAULT_TAG_COLOR })
      .select('id')
      .single()
    if (error) {
      if (isUnique(error)) {
        const { data: again } = await db
          .from('tags').select('id').eq('account_id', accountId).ilike('name', tagName).maybeSingle()
        tagId = again?.id ?? null
      } else {
        console.error('[gateway] tag falhou', error.message)
        return
      }
    } else {
      tagId = created.id
    }
  }
  if (!tagId) return
  // vínculo (ignora se já existir)
  await db.from('contact_tags').insert({ contact_id: contactId, tag_id: tagId })
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  const db = admin()

  const { data: cfg } = await db
    .from('gateway_webhook_config')
    .select('*')
    .eq('token', token)
    .eq('enabled', true)
    .maybeSingle()
  if (!cfg) return ack('config_not_found')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any
  try {
    body = await request.json()
  } catch {
    return ack('bad_json')
  }

  const trigger = str(body?.trigger) ?? str(body?.event) ?? 'unknown'
  const sale = body?.sale ?? {}
  const product = body?.product ?? {}
  const client = body?.client ?? {}
  const orderId = str(sale.id) ?? str(body?.id) ?? ''

  // Idempotência: 1 processamento por (config, pedido, trigger).
  if (orderId) {
    const { error: dupErr } = await db
      .from('gateway_events')
      .insert({ config_id: cfg.id, order_id: orderId, trigger })
    if (dupErr && isUnique(dupErr)) return ack('duplicate', { order_id: orderId })
  }

  const stageMap = (cfg.stage_map ?? {}) as Record<string, string>
  const target = stageMap[trigger]
  if (!target) {
    console.log('[gateway] trigger sem mapeamento:', trigger, '— config', cfg.id)
    return ack('unmapped_trigger', { trigger })
  }

  // owner da conta (preenche os user_id NOT NULL)
  const { data: acc } = await db
    .from('accounts').select('owner_user_id').eq('id', cfg.account_id).maybeSingle()
  const ownerId = acc?.owner_user_id
  if (!ownerId) return ack('account_owner_missing')

  // Contato — dedup por phone_normalized (mesma chave do resto do CRM)
  const name = str(client.name) ?? 'Lead (gateway)'
  const phoneRaw = str(client.cellphone) ?? str(client.phone) ?? ''
  const phone = normalizePhone(phoneRaw)
  const email = str(client.email)

  let contactId: string
  const { data: existing } = await db
    .from('contacts')
    .select('id, name, email')
    .eq('account_id', cfg.account_id)
    .eq('phone_normalized', phone)
    .maybeSingle()
  if (existing) {
    contactId = existing.id
    const patch: Record<string, string> = {}
    if (!existing.name && name) patch.name = name
    if (!existing.email && email) patch.email = email
    if (Object.keys(patch).length) await db.from('contacts').update(patch).eq('id', contactId)
  } else {
    const { data: created, error: cErr } = await db
      .from('contacts')
      .insert({ account_id: cfg.account_id, user_id: ownerId, phone: phoneRaw || phone, name, email })
      .select('id')
      .single()
    if (cErr || !created) {
      const { data: again } = await db
        .from('contacts').select('id').eq('account_id', cfg.account_id).eq('phone_normalized', phone).maybeSingle()
      if (!again) return ack('contact_failed', { err: cErr?.message })
      contactId = again.id
    } else {
      contactId = created.id
    }
  }

  // Tag do produto de interesse (ex.: "Rotina Que Vende")
  const productTag = str(product.name)
  await tagContact(db, cfg.account_id, ownerId, contactId, productTag)

  // REFUND/revoga: marca o negócio desse contato no funil como perdido + tag
  if (target === 'refund') {
    await db
      .from('deals')
      .update({ status: 'lost' })
      .eq('account_id', cfg.account_id)
      .eq('pipeline_id', cfg.pipeline_id)
      .eq('contact_id', contactId)
    await tagContact(db, cfg.account_id, ownerId, contactId, 'Reembolsado')
    return NextResponse.json({ ok: true, action: 'refund', contact_id: contactId }, { status: 200 })
  }

  // Venda/abandono. A Voomp dispara por produto, então a mesma pessoa pode
  // gerar vários eventos (abandonou → comprou). Mantemos UM negócio aberto
  // por contato no funil e só AVANÇAMOS de etapa (nunca puxamos pra trás —
  // nem por evento, nem desfazendo um avanço manual do time).
  const { data: targetStage } = await db
    .from('pipeline_stages').select('position').eq('id', target).maybeSingle()

  const { data: openDeal } = await db
    .from('deals')
    .select('id, stage_id')
    .eq('account_id', cfg.account_id)
    .eq('pipeline_id', cfg.pipeline_id)
    .eq('contact_id', contactId)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (openDeal) {
    let advanced = false
    if (targetStage) {
      const { data: curStage } = await db
        .from('pipeline_stages').select('position').eq('id', openDeal.stage_id).maybeSingle()
      if (curStage && targetStage.position > curStage.position) {
        await db
          .from('deals')
          .update({ stage_id: target, updated_at: new Date().toISOString() })
          .eq('id', openDeal.id)
        advanced = true
      }
    }
    return NextResponse.json(
      { ok: true, action: trigger, contact_id: contactId, deal_id: openDeal.id, advanced, tag: productTag },
      { status: 200 },
    )
  }

  const amount =
    typeof sale.amount === 'number'
      ? sale.amount
      : typeof product.amount === 'number'
        ? product.amount
        : 0
  const { data: deal } = await db
    .from('deals')
    .insert({
      account_id: cfg.account_id,
      user_id: ownerId,
      pipeline_id: cfg.pipeline_id,
      stage_id: target,
      contact_id: contactId,
      title: `${productTag ?? 'Low Ticket'} — ${name}`,
      status: 'open',
      value: amount,
      notes: `Gateway ${cfg.provider} · pedido ${orderId} · ${trigger}${str(sale.method) ? ` · ${sale.method}` : ''}`,
    })
    .select('id')
    .single()

  return NextResponse.json(
    { ok: true, action: trigger, contact_id: contactId, deal_id: deal?.id ?? null, created: true, tag: productTag },
    { status: 200 },
  )
}
