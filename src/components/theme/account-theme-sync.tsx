"use client";

import { useEffect, useRef } from "react";

import { useAuth } from "@/hooks/use-auth";
import { useTheme } from "@/hooks/use-theme";
import { DEFAULT_THEME, isThemeId } from "@/lib/themes";

/**
 * Aplica a cor de destaque (paleta) DA CONTA/marca ativa.
 *
 * A paleta é por conta (accounts.accent, migration 032): ao entrar ou
 * trocar de marca, aplicamos o accent salvo daquela marca. NULL → tema
 * padrão. Só reagimos à troca de `account.id` (não a mudanças do mesmo id)
 * pra não reverter um pick em andamento — o appearance-panel já aplica via
 * setTheme na hora e persiste no banco. Headless.
 */
export function AccountThemeSync() {
  const { account } = useAuth();
  const { setTheme } = useTheme();
  const appliedFor = useRef<string | null>(null);

  useEffect(() => {
    const id = account?.id;
    if (!id || appliedFor.current === id) return;
    appliedFor.current = id;
    const accent = account?.accent;
    setTheme(isThemeId(accent) ? accent : DEFAULT_THEME);
  }, [account?.id, account?.accent, setTheme]);

  return null;
}
