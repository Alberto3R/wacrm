import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { fireConversion } from '@/lib/conversions/capi'

// ============================================================
// POST /api/conversions/fire — disparo de conversão (CAPI)
//
// Chamado pelo trigger do banco (pg_net) quando um deal entra num estágio
// com `capi_event` configurado. Resolve a conta/contato do deal e manda o
// evento pra Conversions API da Meta (com o ctwa_clid do lead).
//
// Auth interna: header `x-conv-token` == CONVERSIONS_INTERNAL_TOKEN.
// Sempre responde 200 pra o pg_net não ficar re-tentando.
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

export async function POST(request: Request) {
  if (request.headers.get('x-conv-token') !== process.env.CONVERSIONS_INTERNAL_TOKEN) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: false, reason: 'bad_json' }, { status: 200 })
  }
  const dealId = body?.deal_id
  const eventName = body?.event_name
  if (!dealId || !eventName) {
    return NextResponse.json({ ok: false, reason: 'missing_fields' }, { status: 200 })
  }

  const db = admin()
  const { data: deal } = await db
    .from('deals')
    .select('account_id, contact_id, value, currency')
    .eq('id', dealId)
    .maybeSingle()
  if (!deal?.contact_id) {
    return NextResponse.json({ ok: false, reason: 'deal_not_found' }, { status: 200 })
  }

  const result = await fireConversion({
    supabase: db,
    accountId: deal.account_id,
    contactId: deal.contact_id,
    eventName,
    value: eventName === 'Purchase' ? Number(deal.value) || undefined : undefined,
    currency: deal.currency ?? undefined,
  })

  return NextResponse.json({ ok: result.ok, reason: result.reason }, { status: 200 })
}
