-- ============================================================
-- 035_gateway_recovery.sql — recuperação de venda (PIX não pago)
--
-- Quando o gateway manda um evento de PIX gerado mas não pago
-- (Voomp: currentStatus='waiting_payment'), o webhook tagueia o lead com
-- "Recuperação" e dispara um template aprovado de recuperação. O nome do
-- template fica na config (por conta/cliente).
-- ============================================================

ALTER TABLE public.gateway_webhook_config ADD COLUMN IF NOT EXISTS recovery_template text;
