-- ============================================================
-- 029_lead_attribution.sql — atribuição de leads (tráfego pago)
--
-- Uma linha por lead capturado, guardando a origem de marketing pra
-- relatórios futuros: UTMs + ângulo do anúncio + ids do Meta pixel
-- (fbclid/fbp/fbc) e, na Fase 2, o ctwa_clid dos anúncios Click-to-
-- WhatsApp. Liga ao contato e ao deal criados na captação.
--
-- Preenchida por:
--   - POST /api/leads (Funil 2: landing → CRM)
--   - (futuro) webhook do WhatsApp, quando vier referral.ctwa_clid
-- ============================================================

CREATE TABLE IF NOT EXISTS public.lead_attribution (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id    uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_id    uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  deal_id       uuid REFERENCES public.deals(id) ON DELETE SET NULL,
  -- de onde veio: 'funil2-landing', 'ctwa', 'organico', ...
  source        text,
  utm_source    text,
  utm_medium    text,
  utm_campaign  text,
  utm_content   text,
  utm_term      text,
  -- ângulo do criativo (?ang=E|B na landing)
  ang           text,
  -- ids de clique/cookie do Meta (pra Conversions API e dedup)
  fbclid        text,
  fbp           text,
  fbc           text,
  event_id      text,
  -- Click-to-WhatsApp Click ID (Fase 2 — vem do referral do webhook)
  ctwa_clid     text,
  ad_id         text,
  -- classificação do gate do funil: verde | amarelo | vermelho
  classificacao text,
  landing_url   text,
  -- payload bruto da captação, pra auditoria e relatórios ad-hoc
  raw           jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_attr_account_created
  ON public.lead_attribution(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_attr_contact
  ON public.lead_attribution(contact_id);
CREATE INDEX IF NOT EXISTS idx_lead_attr_ctwa
  ON public.lead_attribution(ctwa_clid) WHERE ctwa_clid IS NOT NULL;

ALTER TABLE public.lead_attribution ENABLE ROW LEVEL SECURITY;

-- Membros da conta leem (relatórios). A escrita é via service-role no
-- endpoint de captação (que não tem sessão de usuário), então não há
-- policy de INSERT pra clientes — fica fechado por padrão.
DROP POLICY IF EXISTS "members read lead_attribution" ON public.lead_attribution;
CREATE POLICY "members read lead_attribution" ON public.lead_attribution
  FOR SELECT USING (public.is_account_member(account_id));
