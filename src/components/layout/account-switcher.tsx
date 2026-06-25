"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Check, ChevronsUpDown, Building2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface BrandAccount {
  id: string;
  name: string;
}

/**
 * Seletor de marca — troca a conta ativa do usuário. Cada marca
 * (Sales 3R, AUGRA, Elas que Vendem) é uma conta própria com seu
 * número de WhatsApp; o usuário é membro de várias (tabela
 * `account_members`). A troca chama o RPC `switch_account`, que move
 * `profiles.account_id`; o reload recarrega todo o app no contexto da
 * marca escolhida. Só aparece quando há 2+ marcas.
 */
export function AccountSwitcher() {
  const { account, accountId } = useAuth();
  const [accounts, setAccounts] = useState<BrandAccount[]>([]);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    supabase
      .from("accounts")
      .select("id, name")
      .order("name")
      .then(({ data }) => {
        if (data) setAccounts(data as BrandAccount[]);
      });
  }, [accountId]);

  // Nada a trocar com 0/1 marca — não polui a sidebar do usuário solo.
  if (accounts.length < 2) return null;

  const switchTo = async (id: string) => {
    if (id === accountId || switching) return;
    setSwitching(true);
    const supabase = createClient();
    const { error } = await supabase.rpc("switch_account", {
      target_account_id: id,
    });
    if (error) {
      console.error("[AccountSwitcher] switch_account error:", error.message);
      setSwitching(false);
      return;
    }
    // Reload completo: todo dado é escopado por conta via RLS, então
    // recarregar é a forma mais segura de refletir a marca ativa.
    window.location.reload();
  };

  return (
    <div className="border-b border-border px-3 py-2">
      <DropdownMenu>
        <DropdownMenuTrigger className="flex w-full items-center gap-2 rounded-lg border border-border bg-card-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted focus:outline-none data-popup-open:bg-muted">
          <Building2 className="size-4 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate font-medium text-foreground">
            {account?.name ?? "Selecionar marca"}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={6}
          className="min-w-56 bg-popover text-popover-foreground ring-border"
        >
          {accounts.map((a) => (
            <DropdownMenuItem
              key={a.id}
              onClick={() => switchTo(a.id)}
              className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
            >
              <Building2 className="size-4 text-muted-foreground" />
              <span className="flex-1 truncate">{a.name}</span>
              {a.id === accountId ? (
                <Check className="size-4 text-primary" />
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
