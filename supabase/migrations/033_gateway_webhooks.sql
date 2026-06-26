-- ============================================================
-- 033_gateway_webhooks.sql — webhooks de gateway de pagamento (Voomp etc.)
--
-- Recebe vendas/abandonos de um gateway e joga o lead num funil, com tag de
-- produto e na etapa do evento. Config por conta (token na URL identifica a
-- conta + o mapeamento), pra a mesma infra servir vários clientes via UI.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.gateway_webhook_config (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name        text NOT NULL,
  provider    text NOT NULL DEFAULT 'voomp',
  token       text NOT NULL UNIQUE,          -- segredo na URL do webhook
  pipeline_id uuid REFERENCES public.pipelines(id) ON DELETE SET NULL,
  -- mapeia trigger do gateway -> etapa (stage_id) OU a string 'refund'
  -- ex.: {"salePaid":"<uuid>","abandonedCart":"<uuid>","saleRefunded":"refund"}
  stage_map   jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.gateway_webhook_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "members read gateway config" ON public.gateway_webhook_config;
CREATE POLICY "members read gateway config" ON public.gateway_webhook_config
  FOR SELECT USING (public.is_account_member(account_id));
DROP POLICY IF EXISTS "admins write gateway config" ON public.gateway_webhook_config;
CREATE POLICY "admins write gateway config" ON public.gateway_webhook_config
  FOR ALL USING (public.is_account_member(account_id, 'admin'))
  WITH CHECK (public.is_account_member(account_id, 'admin'));

-- Idempotência: cada (config, order_id, trigger) processado uma vez só.
CREATE TABLE IF NOT EXISTS public.gateway_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id  uuid NOT NULL REFERENCES public.gateway_webhook_config(id) ON DELETE CASCADE,
  order_id   text NOT NULL,
  trigger    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (config_id, order_id, trigger)
);
ALTER TABLE public.gateway_events ENABLE ROW LEVEL SECURITY;
-- sem policy de cliente: só service-role (o endpoint) escreve/lê.
