import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data?.account_id) return null
  return data.account_id as string
}

const DEFAULTS = {
  enabled: false,
  system_prompt: '',
  model: 'claude-sonnet-4-6',
  max_tokens: 1500,
  handoff_keyword: '',
  handoff_message: 'Vou te passar pro nosso time, um instante 🙂',
}

/** GET /api/ai-agent/config — config do agente da conta ativa. */
export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const accountId = await resolveAccountId(supabase, user.id)
  if (!accountId) {
    return NextResponse.json({ error: 'No account' }, { status: 400 })
  }
  const { data } = await supabase
    .from('ai_agent_config')
    .select(
      'enabled, system_prompt, model, max_tokens, handoff_keyword, handoff_message',
    )
    .eq('account_id', accountId)
    .maybeSingle()
  return NextResponse.json({ config: data ?? DEFAULTS })
}

/** PUT /api/ai-agent/config — salva (upsert). RLS exige admin+. */
export async function PUT(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const accountId = await resolveAccountId(supabase, user.id)
  if (!accountId) {
    return NextResponse.json({ error: 'No account' }, { status: 400 })
  }

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const rawTokens = Number(body.max_tokens)
  const update = {
    account_id: accountId,
    enabled: body.enabled === true,
    system_prompt: typeof body.system_prompt === 'string' ? body.system_prompt : '',
    model:
      typeof body.model === 'string' && body.model.trim()
        ? body.model.trim()
        : DEFAULTS.model,
    max_tokens: Number.isFinite(rawTokens)
      ? Math.min(4000, Math.max(256, Math.floor(rawTokens)))
      : DEFAULTS.max_tokens,
    handoff_keyword:
      typeof body.handoff_keyword === 'string' && body.handoff_keyword.trim()
        ? body.handoff_keyword.trim()
        : null,
    handoff_message:
      typeof body.handoff_message === 'string' && body.handoff_message.trim()
        ? body.handoff_message.trim()
        : DEFAULTS.handoff_message,
    updated_at: new Date().toISOString(),
  }

  const { data, error } = await supabase
    .from('ai_agent_config')
    .upsert(update, { onConflict: 'account_id' })
    .select(
      'enabled, system_prompt, model, max_tokens, handoff_keyword, handoff_message',
    )
    .maybeSingle()

  if (error) {
    // 42501 = RLS negou (não-admin tentando salvar)
    const status = error.code === '42501' ? 403 : 400
    return NextResponse.json({ error: error.message }, { status })
  }
  return NextResponse.json({ config: data })
}
