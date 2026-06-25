// Orquestra um turno do agente de IA dentro do webhook de recebimento.
//
// Disparado por processMessage() depois que a mensagem do cliente já foi
// inserida — e SOMENTE quando nenhum flow consumiu a mensagem. Lê a config
// do agente da conta, monta o histórico, chama o motor (respond.ts), envia
// a resposta pelo WhatsApp e grava como mensagem do bot. Lida com handoff
// (por palavra-chave do cliente ou decisão do modelo): marca a conversa e
// para de responder até um humano reabrir.

import type { SupabaseClient } from '@supabase/supabase-js'
import { runAgent, type AgentTurn } from './respond'

const GRAPH_VERSION = 'v22.0'
const HISTORY_LIMIT = 20

async function sendText(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  text: string,
): Promise<string | null> {
  try {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body: text },
        }),
      },
    )
    if (!res.ok) {
      console.error('[ai-agent] envio falhou', res.status, await res.text())
      return null
    }
    const data = (await res.json()) as { messages?: { id?: string }[] }
    return data?.messages?.[0]?.id ?? null
  } catch (err) {
    console.error('[ai-agent] envio erro', err)
    return null
  }
}

async function insertBotMessage(
  supabase: SupabaseClient,
  conversationId: string,
  text: string,
  metaMessageId: string | null,
): Promise<void> {
  await supabase.from('messages').insert({
    conversation_id: conversationId,
    sender_type: 'bot',
    content_type: 'text',
    content_text: text,
    message_id: metaMessageId,
    status: 'sent',
  })
}

export async function maybeRunAgent(params: {
  supabase: SupabaseClient
  accountId: string
  conversationId: string
  /** Número do cliente (destino da resposta, no formato wa_id). */
  contactWaId: string
  /** Número da marca (origem do envio). */
  phoneNumberId: string
  /** Token de acesso da marca, já descriptografado. */
  accessToken: string
  inboundText: string
}): Promise<void> {
  const {
    supabase,
    accountId,
    conversationId,
    contactWaId,
    phoneNumberId,
    accessToken,
    inboundText,
  } = params

  if (!inboundText.trim()) return // v1: responde só a texto

  // 1. Config do agente da conta
  const { data: cfg } = await supabase
    .from('ai_agent_config')
    .select('enabled, system_prompt, model, max_tokens, handoff_keyword, handoff_message')
    .eq('account_id', accountId)
    .maybeSingle()
  if (!cfg || !cfg.enabled || !cfg.system_prompt?.trim()) return

  // 2. Conversa já em handoff → humano no comando, bot não responde
  const { data: conv } = await supabase
    .from('conversations')
    .select('ai_handoff')
    .eq('id', conversationId)
    .maybeSingle()
  if (conv?.ai_handoff) return

  // 3. Handoff por palavra-chave do cliente
  const kw = (cfg.handoff_keyword ?? '').trim().toLowerCase()
  if (kw && inboundText.toLowerCase().includes(kw)) {
    const mid = await sendText(phoneNumberId, accessToken, contactWaId, cfg.handoff_message)
    await insertBotMessage(supabase, conversationId, cfg.handoff_message, mid)
    await supabase
      .from('conversations')
      .update({ ai_handoff: true, status: 'pending', updated_at: new Date().toISOString() })
      .eq('id', conversationId)
    return
  }

  // 4. Histórico (últimas N mensagens com texto, em ordem cronológica)
  const { data: msgs } = await supabase
    .from('messages')
    .select('sender_type, content_text, created_at')
    .eq('conversation_id', conversationId)
    .not('content_text', 'is', null)
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT)
  const ordered = (msgs ?? []).slice().reverse()
  // A mensagem nova já foi inserida — remove do histórico pra não duplicar
  // (ela vai separada em incomingText).
  const last = ordered[ordered.length - 1]
  if (last && last.sender_type === 'customer' && last.content_text === inboundText) {
    ordered.pop()
  }
  const history: AgentTurn[] = ordered.map((m) => ({
    fromCustomer: m.sender_type === 'customer',
    text: m.content_text as string,
  }))

  // 5. Roda o agente
  const result = await runAgent({
    config: {
      system_prompt: cfg.system_prompt,
      model: cfg.model,
      max_tokens: cfg.max_tokens,
    },
    history,
    incomingText: inboundText,
  })
  if (!result || !result.reply.trim()) return

  // 6. Envia a resposta + grava como mensagem do bot
  const mid = await sendText(phoneNumberId, accessToken, contactWaId, result.reply)
  await insertBotMessage(supabase, conversationId, result.reply, mid)
  await supabase
    .from('conversations')
    .update({
      last_message_text: result.reply,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      // 7. Handoff decidido pelo modelo → para de responder, espera humano
      ...(result.handoff ? { ai_handoff: true, status: 'pending' } : {}),
    })
    .eq('id', conversationId)
}
