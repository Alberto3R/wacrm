-- ============================================================
-- 031_bsuid.sql — suporte a WhatsApp Business-Scoped User ID (BSUID)
--
-- Com os usernames do WhatsApp (obrigatório ~jun/2026), um lead pode
-- chegar identificado por um BSUID (ex.: "BR.13491208…") em vez do
-- telefone. Guardamos o BSUID no contato pra (a) deduplicar com exatidão
-- e (b) conseguir responder mesmo sem telefone (o BSUID é aceito no `to`).
-- ============================================================

ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS wa_user_id text;

-- Um BSUID identifica unicamente um par usuário↔conta.
CREATE UNIQUE INDEX IF NOT EXISTS contacts_account_wa_user_id_uniq
  ON public.contacts (account_id, wa_user_id)
  WHERE wa_user_id IS NOT NULL;
