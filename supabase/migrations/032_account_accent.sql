-- ============================================================
-- 032_account_accent.sql — cor de destaque (paleta) por conta/marca
--
-- Antes o accent era global por dispositivo (localStorage), então mudar a
-- cor numa marca mudava em todas. Agora cada conta tem o seu `accent`
-- (um ThemeId, ex. 'sales3r'); o app aplica o da marca ativa ao trocar de
-- conta. NULL = cai no tema padrão. Admins da conta podem alterar
-- (policy `accounts_update` já existente, is_account_member(id,'admin')).
-- ============================================================

ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS accent text;
