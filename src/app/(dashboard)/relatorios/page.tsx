"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, BarChart3 } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

// Relatório de tráfego pago: atribuição dos leads (fonte, campanha, ângulo,
// classificação). Os dados vêm da `lead_attribution`, capturada pela
// captação e pelo webhook (ctwa). Agregação client-side (volume baixo).

interface Row {
  source: string | null;
  utm_campaign: string | null;
  ang: string | null;
  classificacao: string | null;
  ctwa_clid: string | null;
  created_at: string | null;
}

type Period = "30" | "90" | "all";

const NA = "(não informado)";

function tally(rows: Row[], key: keyof Row): [string, number][] {
  const m = new Map<string, number>();
  for (const r of rows) {
    const v = (r[key] as string | null)?.trim() || NA;
    m.set(v, (m.get(v) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function AggCard({ title, data, total }: { title: string; data: [string, number][]; total: number }) {
  const max = data[0]?.[1] ?? 1;
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-3 text-sm font-semibold text-foreground">{title}</h3>
      {data.length === 0 ? (
        <p className="text-xs text-muted-foreground">Sem dados.</p>
      ) : (
        <div className="space-y-2.5">
          {data.map(([label, n]) => (
            <div key={label}>
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="truncate text-sm text-foreground" title={label}>
                  {label}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {n} · {total ? Math.round((n / total) * 100) : 0}%
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${(n / max) * 100}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function RelatoriosPage() {
  const supabase = createClient();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<Period>("90");

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("lead_attribution")
      .select("source, utm_campaign, ang, classificacao, ctwa_clid, created_at")
      .order("created_at", { ascending: false })
      .limit(5000);
    setRows((data as Row[]) ?? []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    if (period === "all") return rows;
    const days = period === "30" ? 30 : 90;
    const cutoff = Date.now() - days * 86400000;
    return rows.filter((r) => r.created_at && new Date(r.created_at).getTime() >= cutoff);
  }, [rows, period]);

  const total = filtered.length;
  const ctwaCount = filtered.filter((r) => r.ctwa_clid).length;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-foreground">
            <BarChart3 className="size-6 text-primary" />
            Relatórios
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Atribuição dos leads de tráfego — fonte, campanha e ângulo que mais trazem gente.
          </p>
        </div>
        <div className="flex gap-1 rounded-lg border border-border bg-card p-1">
          {(["30", "90", "all"] as Period[]).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={cn(
                "rounded-md px-3 py-1 text-sm font-medium transition-colors",
                period === p
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {p === "all" ? "Tudo" : `${p}d`}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="mt-8 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Carregando…
        </div>
      ) : total === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-border bg-card p-8 text-center">
          <p className="text-sm text-muted-foreground">
            Ainda não há leads com atribuição no período. Assim que os anúncios
            trouxerem leads (landing ou Click-to-WhatsApp), eles aparecem aqui por
            campanha, ângulo e fonte.
          </p>
        </div>
      ) : (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="text-xs text-muted-foreground">Leads no período</div>
              <div className="mt-1 text-2xl font-bold text-foreground">{total}</div>
            </div>
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="text-xs text-muted-foreground">De Click-to-WhatsApp</div>
              <div className="mt-1 text-2xl font-bold text-foreground">{ctwaCount}</div>
            </div>
            <div className="rounded-xl border border-border bg-card p-4">
              <div className="text-xs text-muted-foreground">Verdes (qualificados)</div>
              <div className="mt-1 text-2xl font-bold text-foreground">
                {filtered.filter((r) => r.classificacao?.toLowerCase() === "verde").length}
              </div>
            </div>
          </div>

          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <AggCard title="Por campanha" data={tally(filtered, "utm_campaign")} total={total} />
            <AggCard title="Por ângulo" data={tally(filtered, "ang")} total={total} />
            <AggCard title="Por fonte" data={tally(filtered, "source")} total={total} />
            <AggCard title="Por classificação" data={tally(filtered, "classificacao")} total={total} />
          </div>
        </>
      )}
    </div>
  );
}
