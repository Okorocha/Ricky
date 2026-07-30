import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, TrendingUp, Activity, Shield, Bell, Play, Zap, History, AlertTriangle, ChevronDown, BarChart2, Target } from "lucide-react";
import { toast } from "sonner";

function PriceDisplay({ price, spread, source }: { price: number; spread: number; source: string }) {
  return (
    <Card className="border-amber-500/20 bg-gradient-to-br from-[#0a0f1a] via-[#0d1525] to-[#0a0f1a]">
      <CardContent className="p-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-slate-500 tracking-wider uppercase">XAU/USD</p>
            <p className="text-3xl font-bold text-amber-400 mt-0.5 tabular-nums">${price.toFixed(2)}</p>
            <p className="text-[11px] text-slate-600 mt-1">{source} · Spread ${spread.toFixed(2)}</p>
          </div>
          <div className="w-12 h-12 rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
            <span className="text-xl">Au</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function PriceError() {
  return (
    <Card className="border-rose-500/20 bg-gradient-to-br from-[#0a0f1a] via-[#0d1525] to-[#0a0f1a]">
      <CardContent className="p-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-rose-500/10 border border-rose-500/20 flex items-center justify-center flex-shrink-0">
            <AlertTriangle className="w-4 h-4 text-rose-400" />
          </div>
          <div>
            <p className="text-sm font-semibold text-rose-400">Price fetch failed</p>
            <p className="text-[11px] text-slate-600 mt-0.5">Twelve Data unavailable — retrying every 15s</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function StatBox({ label, value, className }: { label: string; value: number | string; className?: string }) {
  return (
    <div className="text-center p-2 rounded-lg bg-slate-900/40">
      <p className={`text-xl font-bold tabular-nums ${className}`}>{value}</p>
      <p className="text-[10px] text-slate-600 mt-0.5">{label}</p>
    </div>
  );
}

function statusBadge(status: string) {
  switch (status) {
    case "SWEEP":
      return <Badge className="text-[10px] h-4 px-1.5 bg-rose-500/20 text-rose-300 border-rose-500/30 border">SWEEP</Badge>;
    case "AT_LEVEL":
      return <Badge className="text-[10px] h-4 px-1.5 bg-amber-500/20 text-amber-300 border-amber-500/30 border">AT LEVEL</Badge>;
    case "ENTERING":
    default:
      return <Badge variant="outline" className="text-[10px] h-4 px-1.5 text-slate-400">FORMING</Badge>;
  }
}

function SignalCard({ signal }: { signal: any }) {
  const isLong = signal.direction.includes("LONG");

  return (
    <div className="p-3 rounded-lg border border-slate-700/40 bg-slate-900/60 hover:border-amber-500/20 transition-colors">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <span className={`text-sm font-bold ${isLong ? "text-emerald-400" : "text-rose-400"}`}>
            {isLong ? "LONG" : "SHORT"}
          </span>
          {statusBadge(signal.status)}
        </div>
        <span className="text-[10px] text-slate-600">{new Date(signal.createdAt).toLocaleTimeString()}</span>
      </div>
      <p className="text-[11px] text-slate-500 mb-1.5">{signal.zoneLabel}</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px]">
        <span className="text-slate-500">Entry</span><span className="text-amber-300 font-mono">${signal.entry.toFixed(2)}</span>
        <span className="text-slate-500">SL</span><span className="text-rose-400 font-mono">${signal.sl.toFixed(2)}</span>
        <span className="text-slate-500">TP1</span><span className="text-emerald-400 font-mono">${signal.tp1.toFixed(2)}</span>
        <span className="text-slate-500">TP2</span><span className="text-emerald-400 font-mono">${signal.tp2.toFixed(2)}</span>
        <span className="text-slate-500">TP3</span><span className="text-emerald-400 font-mono">${signal.tp3.toFixed(2)}</span>
      </div>
    </div>
  );
}

function SetupCard({ setup }: { setup: any }) {
  const isLong = setup.direction.includes("LONG");
  return (
    <div className="p-3 rounded-lg border border-orange-500/20 bg-slate-900/60 hover:border-orange-500/40 transition-colors">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <span className={`text-sm font-bold ${isLong ? "text-emerald-400" : "text-rose-400"}`}>
            {isLong ? "LONG" : "SHORT"}
          </span>
          {statusBadge(setup.status)}
        </div>
        <span className="text-[10px] text-slate-600">{new Date(setup.detectedAt).toLocaleTimeString()}</span>
      </div>
      <p className="text-[11px] text-slate-500 mb-1.5">{setup.zoneLabel}</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px]">
        <span className="text-slate-500">Entry</span><span className="text-amber-300 font-mono">${setup.entry.toFixed(2)}</span>
        <span className="text-slate-500">SL</span><span className="text-rose-400 font-mono">${setup.sl.toFixed(2)}</span>
        <span className="text-slate-500">TP1</span><span className="text-emerald-400 font-mono">${setup.tp1.toFixed(2)}</span>
        <span className="text-slate-500">TP3</span><span className="text-emerald-400 font-mono">${setup.tp3.toFixed(2)}</span>
      </div>
      {setup.session && (
        <p className="text-[10px] text-slate-600 mt-1.5">{setup.session} · {setup.priority}</p>
      )}
    </div>
  );
}

function TradeCard({ trade }: { trade: any }) {
  const isLong = trade.direction.includes("LONG");
  const isOpen = !trade.closed;
  const result = trade.slHit ? "SL" : trade.tp3Hit ? "TP3" : trade.tp2Hit ? "TP2" : trade.tp1Hit ? "TP1+" : null;

  return (
    <div className={`p-3 rounded-lg border bg-slate-900/60 ${isOpen ? "border-emerald-500/30" : "border-slate-700/40"}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          <span className={`text-sm font-bold ${isLong ? "text-emerald-400" : "text-rose-400"}`}>
            {isLong ? "LONG" : "SHORT"}
          </span>
          {isOpen ? (
            <Badge className="text-[9px] h-3.5 px-1 bg-emerald-500/15 text-emerald-400 border-emerald-500/30 border">OPEN</Badge>
          ) : (
            <Badge className="text-[9px] h-3.5 px-1 bg-slate-700/50 text-slate-400 border-slate-600/30 border">CLOSED</Badge>
          )}
        </div>
        <div className="flex gap-1">
          {trade.tp1Hit && <Badge className="text-[9px] h-3.5 px-1 bg-emerald-500/20 text-emerald-400 border-0">TP1</Badge>}
          {trade.tp2Hit && <Badge className="text-[9px] h-3.5 px-1 bg-emerald-500/20 text-emerald-400 border-0">TP2</Badge>}
          {trade.tp3Hit && <Badge className="text-[9px] h-3.5 px-1 bg-emerald-500/20 text-emerald-400 border-0">TP3</Badge>}
          {trade.slHit && <Badge className="text-[9px] h-3.5 px-1 bg-rose-500/20 text-rose-400 border-0">SL</Badge>}
        </div>
      </div>
      <div className="grid grid-cols-4 gap-2 text-[11px]">
        <div><span className="text-slate-600">Entry</span><p className="text-amber-300 font-mono">${trade.entry.toFixed(2)}</p></div>
        <div><span className="text-slate-600">SL</span><p className="text-rose-400 font-mono">${trade.sl.toFixed(2)}</p></div>
        <div><span className="text-slate-600">TP1</span><p className="text-emerald-400 font-mono">${trade.tp1.toFixed(2)}</p></div>
        <div><span className="text-slate-600">TP3</span><p className="text-emerald-400 font-mono">${trade.tp3.toFixed(2)}</p></div>
      </div>
      {!isOpen && result && (
        <p className="text-[10px] mt-1.5 text-slate-500">
          Result: <span className={result === "SL" ? "text-rose-400" : "text-emerald-400"}>{result}</span>
          {trade.slHitAt || trade.tp3HitAt || trade.tp2HitAt || trade.tp1HitAt
            ? ` · ${new Date(trade.slHitAt || trade.tp3HitAt || trade.tp2HitAt || trade.tp1HitAt).toLocaleString()}`
            : ""}
        </p>
      )}
    </div>
  );
}

function LogEntry({ entry }: { entry: any }) {
  const isSuccess = entry.success;
  const time = new Date(entry.sentAt).toLocaleTimeString();
  return (
    <div className={`flex items-start gap-2 py-1.5 border-b border-slate-800/50 last:border-0 text-[11px]`}>
      <span className={`mt-0.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${isSuccess ? "bg-emerald-400" : "bg-rose-400"}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="text-slate-500 font-mono text-[10px]">{entry.type}</span>
          <span className="text-slate-600 text-[10px] flex-shrink-0">{time}</span>
        </div>
        <p className="text-slate-400 truncate">{entry.content.substring(0, 120)}</p>
      </div>
    </div>
  );
}

export default function Home() {
  const { isAuthenticated } = useAuth();
  const [manualScanning, setManualScanning] = useState(false);
  const [manualAlive, setManualAlive] = useState(false);
  const [historyLimit, setHistoryLimit] = useState(10);

  const priceQuery = trpc.bot.price.useQuery(undefined, { refetchInterval: 15000 });
  const signalsQuery = trpc.bot.signals.useQuery(undefined, { refetchInterval: 30000 });
  const tradesQuery = trpc.bot.activeTrades.useQuery(undefined, { refetchInterval: 15000 });
  const tradeHistoryQuery = trpc.bot.tradeHistory.useQuery(undefined, { refetchInterval: 30000 });
  const logQuery = trpc.bot.telegramLog.useQuery(undefined, { refetchInterval: 15000 });
  const setupsQuery = trpc.bot.activeSetups.useQuery(undefined, { refetchInterval: 30000 });
  const statsQuery = trpc.bot.stats.useQuery(undefined, { refetchInterval: 60000 });

  const scanMutation = trpc.bot.triggerScan.useMutation({
    onSuccess: (data) => {
      if (data.setupFound) {
        toast.success(`Setup found! ${data.message}`);
      } else {
        toast.info(`No valid setup found. Last scan completed successfully.`, {
          description: data.reason,
        });
      }
      signalsQuery.refetch();
      tradesQuery.refetch();
      setupsQuery.refetch();
    },
    onError: (e: any) => toast.error("Scan failed: " + e.message),
    onSettled: () => setManualScanning(false),
  });

  const aliveMutation = trpc.bot.aliveCheck.useMutation({
    onSuccess: () => toast.success("Alive check sent"),
    onError: (e: any) => toast.error("Alive failed: " + e.message),
    onSettled: () => setManualAlive(false),
  });

  const price = priceQuery.data;
  const signals = signalsQuery.data || [];
  const trades = tradesQuery.data || [];
  const tradeHistory = tradeHistoryQuery.data || [];
  const logs = logQuery.data || [];
  const setups = setupsQuery.data || [];
  const stats = statsQuery.data;

  const recentSignals = useMemo(() => signals.slice(0, 8), [signals]);
  const todaySignals = useMemo(() => signals.filter((s: any) => new Date(s.createdAt).toDateString() === new Date().toDateString()).length, [signals]);

  // Closed trades only for history section
  const closedTrades = useMemo(() => tradeHistory.filter((t: any) => t.closed), [tradeHistory]);

  // Win rate & P&L summary
  const tradeStats = useMemo(() => {
    if (closedTrades.length === 0) return null;
    const wins = closedTrades.filter((t: any) => t.tp1Hit || t.tp2Hit || t.tp3Hit).length;
    const losses = closedTrades.filter((t: any) => t.slHit && !t.tp1Hit).length;
    const total = wins + losses;
    const winRate = total > 0 ? Math.round((wins / total) * 100) : 0;
    const tp3s = closedTrades.filter((t: any) => t.tp3Hit).length;
    return { wins, losses, total, winRate, tp3s };
  }, [closedTrades]);

  return (
    <div className="min-h-screen bg-[#060a12] text-slate-100">
      {/* Header */}
      <header className="border-b border-slate-800/80 bg-[#0a0f1a]/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-amber-500/15 border border-amber-500/20 flex items-center justify-center">
              <Zap className="w-3.5 h-3.5 text-amber-400" />
            </div>
            <div>
              <h1 className="text-base font-bold text-white leading-none">XAU/USD Bot</h1>
              <p className="text-[9px] text-slate-600 mt-0.5">by Ricky · v2.0</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-[11px] text-emerald-400">LIVE</span>
            </div>
            <div className="flex gap-1.5">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setManualScanning(true);
                  toast.info("Scanning market…");
                  scanMutation.mutate();
                }}
                disabled={manualScanning}
                className="border-amber-500/20 text-amber-400 hover:bg-amber-500/10 text-[11px] h-7 px-2.5"
              >
                {manualScanning ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                {manualScanning ? "Scanning…" : "Scan"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => { setManualAlive(true); aliveMutation.mutate(); }} disabled={manualAlive} className="border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/10 text-[11px] h-7 px-2.5">
                {manualAlive ? <Loader2 className="w-3 h-3 animate-spin" /> : <Bell className="w-3 h-3" />}
                Alive
              </Button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-5 space-y-5">
        {/* Price + Stats row */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="md:col-span-2">
            {priceQuery.isError ? (
              <PriceError />
            ) : price ? (
              <PriceDisplay price={price.price} spread={price.spread} source={price.source} />
            ) : (
              <Card className="bg-[#0a0f1a] border-slate-800"><CardContent className="p-5"><Loader2 className="w-5 h-5 text-slate-700 animate-spin" /></CardContent></Card>
            )}
          </div>
          <Card className="bg-[#0a0f1a] border-slate-800">
            <CardHeader className="pb-1.5"><CardTitle className="text-[11px] text-slate-500 flex items-center gap-1.5"><Activity className="w-3.5 h-3.5" /> Stats</CardTitle></CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-2">
                <StatBox label="Today" value={todaySignals} className="text-amber-400" />
                <StatBox label="Active" value={trades.length} className="text-emerald-400" />
                <StatBox label="Pending" value={setups.length} className="text-orange-400" />
                <StatBox label="Msgs" value={stats?.messages ?? "–"} className="text-sky-400" />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Win Rate & P&L Summary */}
        {tradeStats && (
          <Card className="bg-[#0a0f1a] border-slate-800">
            <CardHeader className="pb-1.5"><CardTitle className="text-[11px] text-slate-500 flex items-center gap-1.5"><BarChart2 className="w-3.5 h-3.5 text-amber-400" /> Performance</CardTitle></CardHeader>
            <CardContent>
              <div className="grid grid-cols-4 gap-2">
                <StatBox label="Win Rate" value={`${tradeStats.winRate}%`} className={tradeStats.winRate >= 50 ? "text-emerald-400" : "text-rose-400"} />
                <StatBox label="Wins" value={tradeStats.wins} className="text-emerald-400" />
                <StatBox label="Losses" value={tradeStats.losses} className="text-rose-400" />
                <StatBox label="TP3 Hits" value={tradeStats.tp3s} className="text-amber-400" />
              </div>
            </CardContent>
          </Card>
        )}

        {/* Active Setups */}
        {setups.length > 0 && (
          <div>
            <h2 className="text-xs font-semibold text-slate-400 mb-2.5 flex items-center gap-1.5"><Target className="w-3.5 h-3.5 text-orange-400" /> Active Setups <span className="text-[10px] text-slate-600">({setups.length})</span></h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {setups.map((s: any) => <SetupCard key={s.id} setup={s} />)}
            </div>
          </div>
        )}

        {/* Active Trades */}
        {trades.length > 0 && (
          <div>
            <h2 className="text-xs font-semibold text-slate-400 mb-2.5 flex items-center gap-1.5"><Shield className="w-3.5 h-3.5 text-emerald-400" /> Active Trades</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {trades.map((t: any) => <TradeCard key={t.id} trade={t} />)}
            </div>
          </div>
        )}

        {/* Recent Signals */}
        <div>
          <h2 className="text-xs font-semibold text-slate-400 mb-2.5 flex items-center gap-1.5"><TrendingUp className="w-3.5 h-3.5 text-amber-400" /> Recent Signals</h2>
          {recentSignals.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {recentSignals.map((s: any) => <SignalCard key={s.id} signal={s} />)}
            </div>
          ) : (
            <div className="text-center py-10 border border-dashed border-slate-800 rounded-lg">
              <p className="text-xs text-slate-600">No signals yet. Bot auto-scans every 15 minutes.</p>
            </div>
          )}
        </div>

        {/* Trade History */}
        {closedTrades.length > 0 && (
          <div>
            <h2 className="text-xs font-semibold text-slate-400 mb-2.5 flex items-center gap-1.5"><History className="w-3.5 h-3.5 text-slate-400" /> Trade History <span className="text-[10px] text-slate-600">({closedTrades.length})</span></h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {closedTrades.slice(0, historyLimit).map((t: any) => <TradeCard key={t.id} trade={t} />)}
            </div>
            {closedTrades.length > historyLimit && (
              <button
                onClick={() => setHistoryLimit(prev => prev + 10)}
                className="mt-3 w-full flex items-center justify-center gap-1.5 py-2 text-[11px] text-slate-500 hover:text-slate-300 border border-slate-800 hover:border-slate-700 rounded-lg transition-colors"
              >
                <ChevronDown className="w-3.5 h-3.5" />
                Show more ({closedTrades.length - historyLimit} remaining)
              </button>
            )}
          </div>
        )}

        {/* Telegram Log */}
        <div>
          <h2 className="text-xs font-semibold text-slate-400 mb-2.5 flex items-center gap-1.5"><Bell className="w-3.5 h-3.5 text-sky-400" /> Telegram Log</h2>
          <Card className="bg-[#0a0f1a] border-slate-800">
            <CardContent className="p-2 max-h-64 overflow-y-auto">
              {logs.length > 0 ? logs.map((entry: any) => <LogEntry key={entry.id} entry={entry} />) : (
                <p className="text-xs text-slate-600 text-center py-6">No messages yet.</p>
              )}
            </CardContent>
          </Card>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800/50 py-3 text-center">
        <p className="text-[10px] text-slate-600">XAU/USD Scalp Signal Engine v2.0 · by Ricky</p>
      </footer>
    </div>
  );
}
