-- ============================================================
-- 034_funnel_metrics.sql — métricas de funil & performance no Painel
--
-- Suporta: taxa de conexão, taxa de conversão, ciclo de venda, motivos
-- de perda, leads sem follow-up humano. Adiciona:
--  • pipeline_stages.is_connection — marca a etapa "conectei com o lead"
--  • deals.closed_at / lost_reason  — fechamento + motivo da perda
--  • trigger que carimba closed_at ao ganhar/perder (limpa ao reabrir)
--  • RPC dashboard_funnel_metrics() — calcula tudo, escopado pela conta
--    ativa (SECURITY INVOKER → RLS aplica).
-- ============================================================

-- Etapa de conexão (configurável por funil; default = etapas "Conexão")
ALTER TABLE public.pipeline_stages ADD COLUMN IF NOT EXISTS is_connection boolean NOT NULL DEFAULT false;
UPDATE public.pipeline_stages SET is_connection = true WHERE name ILIKE 'conex%' AND NOT is_connection;

-- Fechamento do negócio + motivo de perda
ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS closed_at  timestamptz;
ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS lost_reason text;

-- Carimba closed_at quando ganha/perde; limpa (e zera motivo) se reabrir.
CREATE OR REPLACE FUNCTION public.set_deal_closed_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.status IN ('won', 'lost') THEN
    IF NEW.closed_at IS NULL THEN NEW.closed_at := now(); END IF;
  ELSE
    NEW.closed_at := NULL;
    NEW.lost_reason := NULL;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS deals_set_closed_at ON public.deals;
CREATE TRIGGER deals_set_closed_at
  BEFORE INSERT OR UPDATE ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.set_deal_closed_at();

-- Métricas de funil da CONTA ATIVA (RLS aplica via SECURITY INVOKER).
CREATE OR REPLACE FUNCTION public.dashboard_funnel_metrics()
RETURNS json
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH conn AS (
    SELECT pipeline_id, min(position) AS conn_pos
    FROM pipeline_stages WHERE is_connection GROUP BY pipeline_id
  ),
  ds AS (
    SELECT d.status, d.created_at, d.closed_at, d.lost_reason,
           ps.position AS pos, c.conn_pos,
           (c.conn_pos IS NOT NULL AND ps.position >= c.conn_pos) AS reached_conn
    FROM deals d
    JOIN pipeline_stages ps ON ps.id = d.stage_id
    LEFT JOIN conn c ON c.pipeline_id = d.pipeline_id
  )
  SELECT json_build_object(
    'total_deals',     (SELECT count(*) FROM ds),
    'with_conn_stage', (SELECT count(*) FROM ds WHERE conn_pos IS NOT NULL),
    'reached_conn',    (SELECT count(*) FROM ds WHERE reached_conn),
    'won',             (SELECT count(*) FROM ds WHERE status = 'won'),
    'won_from_conn',   (SELECT count(*) FROM ds WHERE status = 'won' AND reached_conn),
    'lost',            (SELECT count(*) FROM ds WHERE status = 'lost'),
    'avg_cycle_seconds', (
      SELECT avg(extract(epoch FROM closed_at - created_at))
      FROM ds WHERE status = 'won' AND closed_at IS NOT NULL
    ),
    'loss_reasons', (
      SELECT coalesce(json_agg(json_build_object('reason', reason, 'count', n) ORDER BY n DESC), '[]'::json)
      FROM (
        SELECT coalesce(nullif(trim(lost_reason), ''), 'Não informado') AS reason, count(*) AS n
        FROM ds WHERE status = 'lost' GROUP BY 1
      ) x
    ),
    'no_human_followup', (
      SELECT count(*) FROM conversations cv
      WHERE cv.status = 'open'
        AND (SELECT max(created_at) FROM messages m WHERE m.conversation_id = cv.id AND m.sender_type = 'customer')
            > coalesce((SELECT max(created_at) FROM messages m WHERE m.conversation_id = cv.id AND m.sender_type = 'agent'), '-infinity'::timestamptz)
    )
  );
$$;
