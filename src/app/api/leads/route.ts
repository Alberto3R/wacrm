import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { fireWebLead } from '@/lib/conversions/capi'

// ============================================================
// POST /api/leads — captação de lead da landing (Funil 2) direto no CRM
//
// A landing posta o objeto `answers` aqui (sem Make no meio). Cria/acha
// o contato, abre um deal no pipeline "Tráfego Pago" no estágio certo
// pela classificação, e grava a atribuição (UTMs + ids do Meta) pra
// relatórios. Escreve com service-role (a landing não tem sessão).
//
// Auth: header `x-lead-token` == LEAD_CAPTURE_TOKEN.
// Conta de destino: LEAD_CAPTURE_ACCOUNT_ID.
// ============================================================

const PIPELINE_NAME = 'Tráfego Pago'

// classificação do gate → estágio do pipeline
const STAGE_BY_STATUS: Record<string, string> = {
  verde: 'Qualificado (verde)',
  amarelo: 'Em avaliação (amarelo)',
  vermelho: 'Off-gate / Perdido',
}
const DEFAULT_STAGE = 'Novo lead'

// `any` para o client service-role — mesmo padrão do webhook/config:
// sem o tipo Database gerado, o supabase-js infere `never` nos inserts.
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

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

export async function POST(request: Request) {
  // 1. Auth
  const token = request.headers.get('x-lead-token')
  if (!token || token !== process.env.LEAD_CAPTURE_TOKEN) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const accountId = process.env.LEAD_CAPTURE_ACCOUNT_ID
  if (!accountId) {
    return NextResponse.json({ error: 'capture not configured' }, { status: 500 })
  }

  // 2. Payload
  let a: Record<string, unknown>
  try {
    a = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }
  const name = str(a.nome) ?? str(a.name) ?? 'Lead (Funil 2)'
  const phoneRaw = str(a.phone_e164) ?? str(a.whatsapp) ?? str(a.telefone)
  if (!phoneRaw) {
    return NextResponse.json({ error: 'missing phone' }, { status: 400 })
  }
  const phone = normalizePhone(phoneRaw)
  const status = (str(a.status) ?? '').toLowerCase()
  const db = admin()

  // 3. Owner da conta (user_id NOT NULL nos inserts) + pipeline + estágio
  const [{ data: acc }, { data: pipeline }] = await Promise.all([
    db.from('accounts').select('owner_user_id').eq('id', accountId).maybeSingle(),
    db
      .from('pipelines')
      .select('id')
      .eq('account_id', accountId)
      .eq('name', PIPELINE_NAME)
      .maybeSingle(),
  ])
  const ownerId = (acc as { owner_user_id?: string } | null)?.owner_user_id
  const pipelineId = (pipeline as { id?: string } | null)?.id
  if (!ownerId || !pipelineId) {
    return NextResponse.json({ error: 'account/pipeline not found' }, { status: 500 })
  }
  const stageName = STAGE_BY_STATUS[status] ?? DEFAULT_STAGE
  const { data: stage } = await db
    .from('pipeline_stages')
    .select('id')
    .eq('pipeline_id', pipelineId)
    .eq('name', stageName)
    .maybeSingle()
  const stageId = (stage as { id?: string } | null)?.id ?? null

  // 4. Contato — dedup por phone_normalized (mesma chave do webhook)
  let contactId: string
  const { data: existing } = await db
    .from('contacts')
    .select('id, name, email')
    .eq('account_id', accountId)
    .eq('phone_normalized', phone)
    .maybeSingle()
  if (existing) {
    contactId = (existing as { id: string }).id
    // completa nome/e-mail se estavam vazios
    const patch: Record<string, string> = {}
    if (!(existing as { name?: string }).name && name) patch.name = name
    if (!(existing as { email?: string }).email && str(a.email)) patch.email = str(a.email)!
    if (Object.keys(patch).length) await db.from('contacts').update(patch).eq('id', contactId)
  } else {
    const { data: created, error: cErr } = await db
      .from('contacts')
      .insert({
        account_id: accountId,
        user_id: ownerId,
        phone: phoneRaw,
        // phone_normalized é coluna GERADA (regexp_replace(phone,'\D','')) —
        // o Postgres calcula sozinho; inserir valor nela dá erro.
        name,
        email: str(a.email),
        company: str(a.empresa) ?? str(a.segmento),
      })
      .select('id')
      .single()
    if (cErr || !created) {
      // corrida de dedup: re-busca
      const { data: again } = await db
        .from('contacts')
        .select('id')
        .eq('account_id', accountId)
        .eq('phone_normalized', phone)
        .maybeSingle()
      if (!again) {
        return NextResponse.json({ error: 'contact insert failed' }, { status: 500 })
      }
      contactId = (again as { id: string }).id
    } else {
      contactId = (created as { id: string }).id
    }
  }

  // 5. Deal no pipeline Tráfego Pago
  const { data: deal } = await db
    .from('deals')
    .insert({
      account_id: accountId,
      user_id: ownerId,
      pipeline_id: pipelineId,
      stage_id: stageId,
      contact_id: contactId,
      title: `${name} — Tráfego pago${status ? ` (${status})` : ''}`,
      status: 'open',
      notes: str(a.segmento) || str(a.faturamento) ? `Segmento: ${str(a.segmento) ?? '—'} · Faturamento: ${str(a.faturamento) ?? '—'}` : null,
    })
    .select('id')
    .single()
  const dealId = (deal as { id?: string } | null)?.id ?? null

  // 6. Atribuição (UTMs + ids do Meta + payload bruto)
  await db.from('lead_attribution').insert({
    account_id: accountId,
    contact_id: contactId,
    deal_id: dealId,
    source: str(a.origem) ?? 'funil2-landing',
    utm_source: str(a.utm_source),
    utm_medium: str(a.utm_medium),
    utm_campaign: str(a.utm_campaign),
    utm_content: str(a.utm_content),
    utm_term: str(a.utm_term),
    ang: str(a.angulo) ?? str(a.ang),
    fbclid: str(a.fbclid),
    fbp: str(a.fbp),
    fbc: str(a.fbc),
    event_id: str(a.event_id),
    classificacao: status || null,
    landing_url: str(a.event_source_url),
    raw: a,
  })

  // 7. CAPI "Lead" server-side (dedup com o pixel do navegador via event_id).
  //    Substitui o disparo que o cenário do Make fazia no Funil 2. Await pra
  //    garantir o envio antes da função serverless congelar; nunca derruba a
  //    resposta (fireWebLead trata os próprios erros).
  const capi = await fireWebLead({
    supabase: db,
    accountId,
    eventId: str(a.event_id),
    eventSourceUrl: str(a.event_source_url),
    fbc: str(a.fbc),
    fbp: str(a.fbp),
    fbclid: str(a.fbclid),
    phone,
    email: str(a.email),
  }).catch(() => ({ ok: false, reason: 'threw' }))

  return NextResponse.json(
    { data: { contact_id: contactId, deal_id: dealId, capi: capi.ok } },
    { status: 200 },
  )
}
