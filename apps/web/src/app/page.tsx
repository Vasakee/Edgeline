"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { io, Socket } from "socket.io-client";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

const fetcher = (url: string) => fetch(url).then((res) => res.json());

interface Opportunity {
  _id: string;
  fixtureId: string;
  homeTeam?: string;
  awayTeam?: string;
  outcome: string;
  modelProb: number;
  marketProb: number;
  divergencePct: number;
  confidence: string;
  detectedAt: string;
}

interface Position {
  _id: string;
  fixtureId: string;
  homeTeam?: string;
  awayTeam?: string;
  outcome: string;
  size: number;
  status: string;
  pnl: number | null;
  decidedAt: string;
  txSignature: string | null;
  reasoning: {
    txSignature?: string;
    failureReason?: string;
    settlementTxSig?: string;
  };
}

export default function Dashboard() {
  const { data: status, mutate: mutateStatus } = useSWR(`${API_BASE}/agent/status`, fetcher, {
    refreshInterval: 5000,
  });

  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [expandedErrors, setExpandedErrors] = useState<Record<string, boolean>>({});
  const [positionFilter, setPositionFilter] = useState<"all" | "settled" | "executed" | "skipped">("all");

  // Priority order: settled first, then executed, then others, skipped last
  const STATUS_PRIORITY: Record<string, number> = { settled: 0, executed: 1, pending: 2, failed: 3, skipped: 4 };
  const sortedPositions = [...positions].sort((a, b) => {
    const pa = STATUS_PRIORITY[a.status] ?? 2;
    const pb = STATUS_PRIORITY[b.status] ?? 2;
    if (pa !== pb) return pa - pb;
    return new Date(b.decidedAt).getTime() - new Date(a.decidedAt).getTime();
  });
  const filteredPositions = positionFilter === "all"
    ? sortedPositions
    : sortedPositions.filter((p) => p.status === positionFilter);

  const positionCounts = positions.reduce<Record<string, number>>((acc, p) => {
    acc[p.status] = (acc[p.status] || 0) + 1;
    return acc;
  }, {});

  // Fetch initial opportunities and positions on mount
  useEffect(() => {
    fetch(`${API_BASE}/agent/opportunities`)
      .then((res) => res.json())
      .then((data) => setOpportunities(data || []))
      .catch((err) => console.error("Error fetching opportunities:", err));

    fetch(`${API_BASE}/agent/positions`)
      .then((res) => res.json())
      .then((data) => setPositions(data || []))
      .catch((err) => console.error("Error fetching positions:", err));
  }, []);

  // Set up WebSockets
  useEffect(() => {
    const socket: Socket = io(API_BASE);

    socket.on("connect", () => {
      console.log("WebSocket connected to API gateway");
    });

    socket.on("opportunity.created", (newOpp: Opportunity) => {
      console.log("WS Opportunity created:", newOpp);
      setOpportunities((prev) => [newOpp, ...prev].slice(0, 50));
      mutateStatus();
    });

    socket.on("position.created", (newPos: Position) => {
      console.log("WS Position created:", newPos);
      setPositions((prev) => [newPos, ...prev].slice(0, 50));
      mutateStatus();
    });

    socket.on("position.updated", (updatedPos: Position) => {
      console.log("WS Position updated:", updatedPos);
      setPositions((prev) =>
        prev.map((pos) => (pos._id === updatedPos._id ? updatedPos : pos))
      );
      mutateStatus();
    });

    socket.on("disconnect", () => {
      console.log("WebSocket disconnected");
    });

    return () => {
      socket.disconnect();
    };
  }, [mutateStatus]);

  const formatUptime = (ms: number) => {
    const hours = Math.floor(ms / 3600000);
    const mins = Math.floor((ms % 3600000) / 60000);
    return `${hours}h ${mins}m`;
  };

  const getStatusBadgeColor = (statusName: string) => {
    switch (statusName) {
      case "pending":
        return "bg-amber-500/20 text-amber-400 border-amber-500/30";
      case "executed":
        return "bg-emerald-500/20 text-emerald-400 border-emerald-500/30";
      case "settled":
        return "bg-blue-500/20 text-blue-400 border-blue-500/30";
      case "failed":
        return "bg-rose-500/20 text-rose-400 border-rose-500/30";
      default:
        return "bg-gray-500/20 text-gray-400 border-gray-500/30";
    }
  };

  const getConfidenceBadgeColor = (conf: string) => {
    switch (conf?.toLowerCase()) {
      case "high":
        return "bg-emerald-500/20 text-emerald-400 border-emerald-500/30";
      case "medium":
        return "bg-amber-500/20 text-amber-400 border-amber-500/30";
      default:
        return "bg-blue-500/20 text-blue-400 border-blue-500/30";
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans p-6 selection:bg-indigo-500/30">
      <div className="max-w-7xl mx-auto space-y-6">
        
        {/* Banner / Header */}
        <header className="flex flex-col md:flex-row justify-between items-start md:items-center p-6 bg-slate-900/60 backdrop-blur-md border border-slate-800 rounded-2xl gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-indigo-400 to-cyan-400 bg-clip-text text-transparent">
                edgeline.
              </h1>
              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${
                status?.status === "running" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : "bg-rose-500/10 text-rose-400 border-rose-500/20"
              }`}>
                ● {status?.status === "running" ? "Autonomous Live" : "Offline / Degraded"}
              </span>
            </div>
            <p className="text-sm text-slate-400 mt-1 font-mono break-all max-w-xl">
              Wallet: <span className="text-slate-300">{status?.wallet || "Connecting..."}</span>
            </p>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 w-full md:w-auto">
            <div className="bg-slate-950/40 p-3 rounded-xl border border-slate-800/80 min-w-[120px]">
              <span className="text-xs text-slate-500 block">Monitored</span>
              <span className="text-lg font-semibold text-slate-200">
                {status?.fixtures?.monitored ?? 0} ({status?.fixtures?.live ?? 0} Live)
              </span>
            </div>
            <div className="bg-slate-950/40 p-3 rounded-xl border border-slate-800/80 min-w-[120px]">
              <span className="text-xs text-slate-500 block">Uptime</span>
              <span className="text-lg font-semibold text-slate-200">{status?.uptime || "0h 0m"}</span>
            </div>
            <div className="bg-slate-950/40 p-3 rounded-xl border border-slate-800/80 min-w-[120px]">
              <span className="text-xs text-slate-500 block">PnL Today</span>
              <span className={`text-lg font-semibold ${
                (status?.today?.totalPnl || 0) >= 0 ? "text-emerald-400" : "text-rose-400"
              }`}>
                {(status?.today?.totalPnl || 0) >= 0 ? "+" : ""}{(status?.today?.totalPnl || 0).toFixed(4)} SOL
              </span>
            </div>
            <div className="bg-slate-950/40 p-3 rounded-xl border border-slate-800/80 min-w-[120px]">
              <span className="text-xs text-slate-500 block">Daily Exposure</span>
              <span className="text-lg font-semibold text-slate-200">
                {status?.exposure?.currentDaily.toFixed(2)} / {status?.exposure?.maxDaily.toFixed(2)} SOL
              </span>
              <span className="text-[10px] text-slate-400 block">({status?.exposure?.utilisation ?? "0%"})</span>
            </div>
          </div>
        </header>

        {/* Opportunities Panel */}
        <section className="bg-slate-900/40 border border-slate-850 rounded-2xl p-6">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-semibold text-slate-200">Recent Model Opportunities</h2>
            <span className="text-xs text-slate-500 font-mono">Real-time update active</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  <th className="pb-3 pl-2">Fixture</th>
                  <th className="pb-3">Outcome</th>
                  <th className="pb-3 text-right">Model Prob</th>
                  <th className="pb-3 text-right">Market Prob</th>
                  <th className="pb-3 text-right">Divergence</th>
                  <th className="pb-3 text-center">Confidence</th>
                  <th className="pb-3 text-right pr-2">Detected</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-850/60 text-sm text-slate-300">
                {opportunities.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-slate-500">
                      No active opportunities detected. Scanning Live fixtures...
                    </td>
                  </tr>
                ) : (
                  opportunities.map((opp) => (
                    <tr key={opp._id} className="hover:bg-slate-900/20 transition-colors">
                      <td className="py-3 pl-2">
                        <span className="text-slate-200 text-sm font-medium">{opp.homeTeam && opp.awayTeam ? `${opp.homeTeam} vs ${opp.awayTeam}` : opp.fixtureId}</span>
                      </td>
                      <td className="py-3 capitalize">
                        <span className="px-2 py-1 rounded bg-slate-800 text-xs font-medium">
                          {opp.outcome}
                        </span>
                      </td>
                      <td className="py-3 text-right font-mono">{(opp.modelProb * 100).toFixed(1)}%</td>
                      <td className="py-3 text-right font-mono">{(opp.marketProb * 100).toFixed(1)}%</td>
                      <td className="py-3 text-right font-mono text-emerald-400 font-medium">
                        +{(opp.divergencePct * 100).toFixed(1)}%
                      </td>
                      <td className="py-3 text-center">
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold border ${getConfidenceBadgeColor(opp.confidence)}`}>
                          {opp.confidence}
                        </span>
                      </td>
                      <td className="py-3 text-right pr-2 text-xs text-slate-500">
                        {new Date(opp.detectedAt).toLocaleTimeString()}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Positions Panel */}
        <section className="bg-slate-900/40 border border-slate-850 rounded-2xl p-6">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-4">
            <h2 className="text-lg font-semibold text-slate-200">Active & Settled Positions</h2>
            <div className="flex items-center gap-2 flex-wrap">
              {(["all", "settled", "executed", "skipped"] as const).map((f) => {
                const count = f === "all" ? positions.length : (positionCounts[f] ?? 0);
                const active = positionFilter === f;
                const colorMap: Record<string, string> = {
                  all: active ? "bg-slate-700 text-slate-100 border-slate-600" : "bg-slate-800/60 text-slate-400 border-slate-700 hover:text-slate-200",
                  settled: active ? "bg-blue-500/30 text-blue-300 border-blue-500/50" : "bg-slate-800/60 text-slate-400 border-slate-700 hover:text-blue-300",
                  executed: active ? "bg-emerald-500/30 text-emerald-300 border-emerald-500/50" : "bg-slate-800/60 text-slate-400 border-slate-700 hover:text-emerald-300",
                  skipped: active ? "bg-gray-500/30 text-gray-300 border-gray-500/50" : "bg-slate-800/60 text-slate-400 border-slate-700 hover:text-gray-300",
                };
                return (
                  <button
                    key={f}
                    onClick={() => setPositionFilter(f)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border transition-colors ${colorMap[f]}`}
                  >
                    <span className="capitalize">{f}</span>
                    <span className="bg-slate-900/60 px-1.5 py-0.5 rounded-full text-[10px]">{count}</span>
                  </button>
                );
              })}
              <span className="text-xs text-slate-500 font-mono ml-1">sorted by status</span>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  <th className="pb-3 pl-2">Fixture</th>
                  <th className="pb-3">Outcome</th>
                  <th className="pb-3 text-right">Size</th>
                  <th className="pb-3 text-center">Status</th>
                  <th className="pb-3">Solana Explorer (Devnet)</th>
                  <th className="pb-3 text-right pr-2">PnL</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-850/60 text-sm text-slate-300">
                {filteredPositions.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-slate-500">
                      {positions.length === 0 ? "No positions created yet." : `No ${positionFilter === "all" ? "" : positionFilter + " "}positions found.`}
                    </td>
                  </tr>
                ) : (
                  filteredPositions.map((pos) => {
                    const txSig = pos.reasoning?.txSignature || pos.txSignature;
                    return (
                      <tr key={pos._id} className="hover:bg-slate-900/20 transition-colors">
                        <td className="py-3 pl-2">
                          <span className="text-slate-200 text-sm font-medium">{pos.homeTeam && pos.awayTeam ? `${pos.homeTeam} vs ${pos.awayTeam}` : pos.fixtureId}</span>
                        </td>
                        <td className="py-3 capitalize">
                          <span className="px-2 py-1 rounded bg-slate-800 text-xs font-medium">
                            {pos.outcome}
                          </span>
                        </td>
                        <td className="py-3 text-right font-mono">{pos.size.toFixed(3)} SOL</td>
                        <td className="py-3 text-center">
                          <span className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-semibold border ${getStatusBadgeColor(pos.status)}`}>
                            {pos.status}
                          </span>
                        </td>
                        <td className="py-3">
                          {txSig ? (
                            <a
                              href={`https://explorer.solana.com/tx/${txSig}?cluster=devnet`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-indigo-400 hover:text-indigo-300 underline font-mono text-xs break-all"
                            >
                              {txSig.slice(0, 16)}...{txSig.slice(-16)}
                            </a>
                          ) : pos.status === "failed" ? (
                            (() => {
                              const isExpanded = !!expandedErrors[pos._id];
                              const errorMsg = pos.reasoning?.failureReason || "Failed execution";
                              return (
                                <div className="max-w-md">
                                  <span
                                    onClick={() => setExpandedErrors(prev => ({ ...prev, [pos._id]: !prev[pos._id] }))}
                                    className="text-xs text-rose-400 italic font-mono cursor-pointer hover:underline block break-all whitespace-pre-wrap"
                                  >
                                    Error: {isExpanded ? errorMsg : `${errorMsg.slice(0, 80)}... (click to expand)`}
                                  </span>
                                </div>
                              );
                            })()
                          ) : pos.status === "skipped" ? (
                            <span className="text-slate-500 text-xs">—</span>
                          ) : (
                            <span className="text-slate-500 text-xs italic">Awaiting Signature...</span>
                          )}
                        </td>
                        <td className="py-3 text-right pr-2 font-mono font-medium">
                          {pos.pnl !== null ? (
                            <span className={pos.pnl >= 0 ? "text-emerald-400" : "text-rose-400"}>
                              {pos.pnl >= 0 ? "+" : ""}{pos.pnl.toFixed(4)} SOL
                            </span>
                          ) : (
                            <span className="text-slate-500 text-xs">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
