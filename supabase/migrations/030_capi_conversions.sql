-- ============================================================
-- 030_capi_conversions.sql — devolver conversões pra Meta (CAPI / CTWA)
--
-- Quando um deal entra num estágio marcado com `capi_event`, um trigger
-- chama (async, via pg_net) o endpoint /api/conversions/fire, que manda
-- o evento pra Conversions API da Meta com o ctwa_clid do lead.
--
-- O token interno do endpoint mora em `app_secrets` (inserido fora da
-- migration, via execute_sql) pra não vazar no repositório.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_net;

-- Segredos internos lidos por triggers. Sem policy de cliente (RLS nega
-- tudo); só service-role e funções SECURITY DEFINER acessam.
CREATE TABLE IF NOT EXISTS public.app_secrets (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.app_secrets ENABLE ROW LEVEL SECURITY;

-- Config da Conversions API por conta (marca)
CREATE TABLE IF NOT EXISTS public.meta_capi_config (
  account_id      uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  enabled         boolean NOT NULL DEFAULT false,
  pixel_id        text,
  capi_token      text,            -- criptografado (AES-256-GCM)
  test_event_code text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.meta_capi_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "members read capi config" ON public.meta_capi_config;
CREATE POLICY "members read capi config" ON public.meta_capi_config
  FOR SELECT USING (public.is_account_member(account_id));
DROP POLICY IF EXISTS "admins write capi config" ON public.meta_capi_config;
CREATE POLICY "admins write capi config" ON public.meta_capi_config
  FOR ALL USING (public.is_account_member(account_id, 'admin'))
  WITH CHECK (public.is_account_member(account_id, 'admin'));

-- Qual evento de conversão cada estágio dispara (NULL = nenhum).
-- Ex.: "Raio-X agendado" -> 'Schedule', "Ganho" -> 'Purchase'.
ALTER TABLE public.pipeline_stages ADD COLUMN IF NOT EXISTS capi_event text;

-- Trigger: deal muda pra um estágio com capi_event -> dispara a conversão.
CREATE OR REPLACE FUNCTION public.fire_conversion_on_stage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event text;
  v_token text;
BEGIN
  IF NEW.stage_id IS NOT DISTINCT FROM OLD.stage_id OR NEW.stage_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT capi_event INTO v_event FROM public.pipeline_stages WHERE id = NEW.stage_id;
  IF v_event IS NULL OR v_event = '' THEN RETURN NEW; END IF;
  SELECT value INTO v_token FROM public.app_secrets WHERE key = 'conversions_internal_token';
  IF v_token IS NULL THEN RETURN NEW; END IF;

  PERFORM net.http_post(
    url := 'https://sales-3r-crm.vercel.app/api/conversions/fire',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-conv-token', v_token
    ),
    body := jsonb_build_object('deal_id', NEW.id, 'event_name', v_event)
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS deals_fire_conversion ON public.deals;
CREATE TRIGGER deals_fire_conversion
  AFTER UPDATE OF stage_id ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.fire_conversion_on_stage();
