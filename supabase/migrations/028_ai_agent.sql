-- ============================================================
-- 028_ai_agent.sql — agente de IA conversacional por conta
--
-- Cada marca (account) pode ter um agente de IA que responde no
-- WhatsApp automaticamente (substitui o bot do Make). Config por conta:
-- liga/desliga, persona (system prompt), modelo, etc. O motor vive em
-- src/lib/ai-agent e é disparado pelo webhook ao receber mensagem.
--
-- Handoff: quando o agente decide passar pra humano (ou um humano
-- responde manualmente), a conversa marca `ai_handoff = true` e o bot
-- para de responder naquela conversa até ser reaberto.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.ai_agent_config (
  account_id      uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  enabled         boolean NOT NULL DEFAULT false,
  system_prompt   text NOT NULL DEFAULT '',
  model           text NOT NULL DEFAULT 'claude-sonnet-4-6',
  max_tokens      integer NOT NULL DEFAULT 1500,
  -- Palavra/expressão que, vinda do cliente, força o handoff pra humano
  -- (além do handoff que o próprio modelo pode decidir). Ex.: "atendente".
  handoff_keyword text,
  -- Linha curta exibida ao cliente quando cai em handoff.
  handoff_message text NOT NULL DEFAULT 'Vou te passar pro nosso time, um instante 🙂',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ai_agent_config ENABLE ROW LEVEL SECURITY;

-- Membros leem; admin+ editam (config é settings-class, como whatsapp_config).
DROP POLICY IF EXISTS "members read ai config" ON public.ai_agent_config;
CREATE POLICY "members read ai config" ON public.ai_agent_config
  FOR SELECT USING (public.is_account_member(account_id));

DROP POLICY IF EXISTS "admins write ai config" ON public.ai_agent_config;
CREATE POLICY "admins write ai config" ON public.ai_agent_config
  FOR ALL USING (public.is_account_member(account_id, 'admin'))
  WITH CHECK (public.is_account_member(account_id, 'admin'));

-- Flag de handoff por conversa: bot para de responder quando true.
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS ai_handoff boolean NOT NULL DEFAULT false;
