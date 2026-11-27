"use client";

import { useMemo, useState } from "react";
import { LEVELS, type EventKind } from "@/lib/engine";
import { BOX_EVENT_LABEL } from "@/lib/iot";
import { clearLogs, logsToCsv, useLogs, type Logs } from "@/lib/logStore";
import { downloadSessionReport } from "@/lib/report";
import { C, LEVEL_COLORS } from "@/lib/theme";
import { Columns, Empty, HBars, LevelTimeline, LineChart, StackBar100 } from "./charts";

type Period = "jour" | "7j" | "30j" | "tout";
type Version = "toutes" | "v1" | "v2";
type Source = "tout" | "plateforme" | "boitier" | "conducteur";

const PERIODS: [Period, string][] = [
  ["jour", "Aujourd’hui"],
  ["7j", "7 jours"],
  ["30j", "30 jours"],
  ["tout", "Tout"],
];
const VERSIONS: [Version, string][] = [
  ["toutes", "V1 + V2"],
  ["v1", "V1 · Google"],
  ["v2", "V2 · Mon modèle"],
];

const KIND_LABEL: Record<EventKind, string> = {
  closure: "Yeux fermés",
  yawn: "Bâillements",
  nod: "Tête qui tombe",
  distraction: "Distractions",
  faceLost: "Visage perdu",
  level: "Changements de niveau",
  calibration: "Calibrations",
};
const SIGN_KINDS: EventKind[] = ["closure", "yawn", "nod", "distraction", "faceLost"];

function since(p: Period) {
  if (p === "tout") return 0;
  if (p === "jour") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  return Date.now() - (p === "7j" ? 7 : 30) * 86_400_000;
}

function duration(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, "0")}`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}

function Card({ title, hint, children, className = "" }: { title: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-line bg-surface p-4 ${className}`}>
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      {hint && <p className="mb-4 text-xs text-muted">{hint}</p>}
      {!hint && <div className="mb-4" />}
      {children}
    </section>
  );
}

function Kpi({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-line bg-surface p-4">
      {accent && <span className="absolute inset-y-0 left-0 w-1" style={{ background: accent }} />}
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-ink">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-faint">{sub}</p>}
    </div>
  );
}

function Segmented<T extends string>({ value, options, onPick }: { value: T; options: [T, string][]; onPick: (v: T) => void }) {
  return (
    <div className="flex rounded-xl border border-line bg-surface p-1 text-sm">
      {options.map(([v, label]) => (
        <button
          key={v}
          onClick={() => onPick(v)}
          className={`rounded-lg px-3 py-1.5 transition ${value === v ? "bg-brand font-semibold text-white" : "text-soft hover:text-ink"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Filtre les logs selon la période et la version. */
function filterLogs(logs: Logs, period: Period, version: Version): Logs {
  const from = since(period);
  return {
    sessions: logs.sessions.filter((s) => s.end >= from && (version === "toutes" || s.variant === version)),
    box: logs.box.filter((b) => b.at >= from),
    acks: logs.acks.filter((a) => a.at >= from),
    latency: logs.latency.filter((l) => l.at >= from),
  };
}

export default function Dashboard() {
  const all = useLogs();
  const [period, setPeriod] = useState<Period>("tout");
  const [version, setVersion] = useState<Version>("toutes");
  const [source, setSource] = useState<Source>("tout");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [reportBusy, setReportBusy] = useState(false);

  const logs = useMemo(() => filterLogs(all, period, version), [all, period, version]);

  const stats = useMemo(() => {
    const { sessions, box, acks, latency } = logs;
    const levelMs = [0, 1, 2, 3].map((l) => sessions.reduce((s, x) => s + x.levelMs[l], 0));
    const watched = levelMs.reduce((a, b) => a + b, 0);
    const kinds = Object.fromEntries(SIGN_KINDS.map((k) => [k, 0])) as Record<EventKind, number>;
    const hours = Array.from({ length: 24 }, () => 0);
    let alerts = 0;
    let dangers = 0;
    for (const s of sessions) {
      for (const e of s.events) {
        if (e.kind in kinds) kinds[e.kind]++;
        if (e.kind !== "calibration" && e.kind !== "level") hours[new Date(e.at).getHours()]++;
      }
      for (const t of s.timeline) {
        if (t.level >= 2) alerts++;
        if (t.level === 3) dangers++;
      }
    }
    const reactions = acks.filter((a) => a.reactionMs != null).map((a) => a.reactionMs as number);
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    const boxCount: Record<string, number> = {};
    for (const b of box) boxCount[b.evenement] = (boxCount[b.evenement] ?? 0) + 1;
    return {
      levelMs,
      watched,
      kinds,
      hours,
      alerts,
      dangers,
      reaction: avg(reactions),
      reactions: reactions.length,
      pauses: acks.filter((a) => a.type === "pause").length,
      sos: boxCount.SOS_ENVOYE ?? 0,
      latency: avg(latency.map((l) => l.ms)),
      boxCount,
    };
  }, [logs]);

  const sessionsDesc = useMemo(() => [...logs.sessions].sort((a, b) => b.start - a.start), [logs.sessions]);
  const selected = sessionsDesc.find((s) => s.id === sessionId) ?? sessionsDesc[0] ?? null;

  // V1 / V2 côte à côte (toujours sur la période choisie, sans le filtre de version)
  const compare = useMemo(() => {
    const from = since(period);
    return (["v1", "v2"] as const).map((v) => {
      const ss = all.sessions.filter((s) => s.variant === v && s.end >= from);
      const ms = ss.reduce((a, s) => a + s.levelMs.reduce((x, y) => x + y, 0), 0);
      const normal = ss.reduce((a, s) => a + s.levelMs[0], 0);
      const alerts = ss.reduce((a, s) => a + s.timeline.filter((t) => t.level >= 2).length, 0);
      const signs = ss.reduce((a, s) => a + s.events.filter((e) => SIGN_KINDS.includes(e.kind)).length, 0);
      return { v, n: ss.length, ms, normalPct: ms ? (normal / ms) * 100 : null, alertsPerH: ms ? alerts / (ms / 3_600_000) : null, signs };
    });
  }, [all.sessions, period]);

  // Journal fusionné (plus récents d'abord)
  const rows = useMemo(() => {
    const r: { at: number; source: Exclude<Source, "tout">; type: string; level?: number; detail: string }[] = [];
    for (const s of logs.sessions)
      for (const e of s.events) r.push({ at: e.at, source: "plateforme", type: KIND_LABEL[e.kind], level: e.level, detail: `${s.variant.toUpperCase()} · ${e.message}` });
    for (const b of logs.box)
      r.push({ at: b.at, source: "boitier", type: BOX_EVENT_LABEL[b.evenement] ?? b.evenement, level: b.niveau, detail: b.detail });
    for (const a of logs.acks)
      r.push({
        at: a.at,
        source: "conducteur",
        type: a.type === "pause" ? "Pause acceptée" : "Alerte vue (bouton)",
        level: a.niveau,
        detail: a.reactionMs != null ? `réaction en ${(a.reactionMs / 1000).toFixed(1)} s` : "",
      });
    return r.filter((x) => source === "tout" || x.source === source).sort((a, b) => b.at - a.at).slice(0, 150);
  }, [logs, source]);

  const exportCsv = () => {
    const blob = new Blob(["﻿" + logsToCsv(logs)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `drivealert-logs-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const empty = all.sessions.length === 0 && all.box.length === 0 && all.acks.length === 0;
  const recent = sessionsDesc.slice(0, 12).reverse();

  return (
    <div className="min-h-screen bg-base text-ink">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-line px-6 py-4">
        <div>
          <h1 className="text-xl font-bold">Tableau de bord · logs</h1>
          <p className="text-xs text-muted">
            Sessions de détection, journal du boîtier ESP32 et réponses du conducteur, enregistrés dans ce navigateur.
            Mise à jour en direct.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented value={period} options={PERIODS} onPick={setPeriod} />
          <Segmented value={version} options={VERSIONS} onPick={setVersion} />
          <button
            onClick={exportCsv}
            disabled={empty}
            className="rounded-lg border border-line bg-surface px-3 py-2 text-sm hover:bg-raised disabled:opacity-40"
          >
            ⤓ Export CSV
          </button>
          <button
            onClick={() => {
              if (confirm("Effacer tous les logs enregistrés dans ce navigateur ?")) clearLogs();
            }}
            disabled={empty}
            className="rounded-lg border border-danger/60 px-3 py-2 text-sm text-danger hover:bg-danger/10 disabled:opacity-40"
          >
            Effacer
          </button>
        </div>
      </header>

      {empty ? (
        <div className="mx-auto mt-16 max-w-md rounded-2xl border border-line bg-surface p-8 text-center">
          <p className="text-lg font-semibold">Aucun log pour le moment</p>
          <p className="mt-2 text-sm text-muted">
            Lancez une détection (onglet V1 ou V2), puis revenez ici : les KPI et les graphes se remplissent en direct.
          </p>
        </div>
      ) : (
        <main className="flex flex-col gap-4 p-6">
          {/* ---- KPI ---- */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
            <Kpi label="Sessions" value={String(logs.sessions.length)} sub={version === "toutes" ? "V1 + V2" : version.toUpperCase()} accent={C.brand} />
            <Kpi label="Temps surveillé" value={duration(stats.watched)} sub="caméra active" accent={C.brand} />
            <Kpi
              label="Temps en état normal"
              value={stats.watched ? `${((stats.levelMs[0] / stats.watched) * 100).toFixed(0)} %` : "–"}
              sub="niveau 0"
              accent={C.ok}
            />
            <Kpi label="Alertes (niv. ≥ 2)" value={String(stats.alerts)} sub={`dont ${stats.dangers} danger`} accent={C.alert} />
            <Kpi label="SOS WhatsApp" value={String(stats.sos)} sub="envoyés par le boîtier" accent={C.danger} />
            <Kpi
              label="Temps de réaction"
              value={stats.reaction != null ? `${(stats.reaction / 1000).toFixed(1)} s` : "–"}
              sub={`moyenne sur ${stats.reactions} appui(s)`}
              accent={C.warn}
            />
            <Kpi label="Pauses acceptées" value={String(stats.pauses)} sub="bouton du boîtier" accent={C.ok} />
            <Kpi
              label="Latence MQTT"
              value={stats.latency != null ? `${Math.round(stats.latency)} ms` : "–"}
              sub={`${logs.latency.length} mesure(s)`}
              accent={C.brand}
            />
          </div>

          {/* ---- Niveaux ---- */}
          <div className="grid gap-4 xl:grid-cols-2">
            <Card title="Répartition du temps par niveau" hint="Part du temps de conduite passée à chaque niveau d’alerte.">
              <StackBar100
                parts={[0, 1, 2, 3].map((l) => ({
                  label: `${l} · ${LEVELS[l].name}`,
                  value: stats.levelMs[l],
                  color: LEVEL_COLORS[l as 0 | 1 | 2 | 3],
                  display: duration(stats.levelMs[l]),
                }))}
              />
            </Card>
            <Card title="Signes de fatigue détectés" hint="Nombre d’événements par type sur la période.">
              <HBars rows={SIGN_KINDS.map((k) => ({ label: KIND_LABEL[k], value: stats.kinds[k] }))} />
            </Card>
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <Card
              title="Chronologie d’une session"
              hint="Niveau d’alerte au fil du temps. Survolez un bloc pour voir l’heure et la durée."
            >
              {selected ? (
                <>
                  <select
                    value={selected.id}
                    onChange={(e) => setSessionId(e.target.value)}
                    className="mb-3 w-full rounded-lg border border-line bg-raised px-3 py-2 text-sm text-ink outline-none focus:border-brand"
                  >
                    {sessionsDesc.map((s) => (
                      <option key={s.id} value={s.id}>
                        {new Date(s.start).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "medium" })} · {s.variant.toUpperCase()} ·{" "}
                        {duration(s.end - s.start)}
                      </option>
                    ))}
                  </select>
                  <LevelTimeline
                    timeline={selected.timeline}
                    start={selected.start}
                    end={selected.end}
                    colors={LEVEL_COLORS}
                    names={LEVELS.map((l) => l.name)}
                  />
                  <p className="mb-1 mt-4 text-xs font-semibold text-soft">Score de fatigue (0–100)</p>
                  <LineChart
                    points={selected.fatigue ?? []}
                    color={C.brand}
                    max={100}
                    height={130}
                    refLine={{ v: 55, label: "fatigue marquée" }}
                    emptyText="Score non enregistré pour cette session (enregistrée avant l’ajout du score)."
                  />
                  <button
                    onClick={async () => {
                      setReportBusy(true);
                      try {
                        await downloadSessionReport(selected, all);
                      } finally {
                        setReportBusy(false);
                      }
                    }}
                    disabled={reportBusy}
                    className="mt-3 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-hi disabled:opacity-40"
                  >
                    {reportBusy ? "Création du PDF…" : "⬇ Rapport PDF de cette session"}
                  </button>
                </>
              ) : (
                <Empty>Aucune session sur cette période.</Empty>
              )}
            </Card>
            <Card title="Alertes par session" hint="12 dernières sessions : nombre de passages à chaque niveau.">
              {recent.length ? (
                <Columns
                  data={recent.map((s) => ({
                    label: new Date(s.start).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }),
                    title: `${new Date(s.start).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })} · ${s.variant.toUpperCase()}`,
                    values: {
                      1: s.timeline.filter((t) => t.level === 1).length,
                      2: s.timeline.filter((t) => t.level === 2).length,
                      3: s.timeline.filter((t) => t.level === 3).length,
                    },
                  }))}
                  series={[1, 2, 3].map((l) => ({ key: String(l), label: `${l} · ${LEVELS[l].name}`, color: LEVEL_COLORS[l as 1 | 2 | 3] }))}
                />
              ) : (
                <Empty>Aucune session sur cette période.</Empty>
              )}
            </Card>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card title="Signes de fatigue par heure de la journée" hint="À quelles heures la fatigue apparaît le plus.">
              <Columns
                data={stats.hours.map((n, h) => ({ label: `${h}h`, title: `${h}h – ${h + 1}h`, values: { n } }))}
                series={[{ key: "n", label: "Événements", color: C.brand }]}
                height={160}
              />
            </Card>
            <Card title="Comparaison V1 / V2" hint="Même période, chaque version séparément.">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr>
                    <th className="pb-2 font-medium">Indicateur</th>
                    <th className="pb-2 text-right font-medium">V1 · Google</th>
                    <th className="pb-2 text-right font-medium">V2 · Mon modèle</th>
                  </tr>
                </thead>
                <tbody className="font-mono tabular-nums">
                  {(
                    [
                      ["Sessions", (c: (typeof compare)[number]) => String(c.n)],
                      ["Temps surveillé", (c: (typeof compare)[number]) => duration(c.ms)],
                      ["Temps en état normal", (c: (typeof compare)[number]) => (c.normalPct != null ? `${c.normalPct.toFixed(0)} %` : "–")],
                      ["Alertes par heure", (c: (typeof compare)[number]) => (c.alertsPerH != null ? c.alertsPerH.toFixed(1) : "–")],
                      ["Signes de fatigue", (c: (typeof compare)[number]) => String(c.signs)],
                    ] as const
                  ).map(([label, f]) => (
                    <tr key={label} className="border-t border-line">
                      <td className="py-2 font-sans text-soft">{label}</td>
                      <td className="py-2 text-right">{f(compare[0])}</td>
                      <td className="py-2 text-right">{f(compare[1])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>

          {/* ---- Boîtier ---- */}
          <div className="grid gap-4 xl:grid-cols-2">
            <Card title="Journal du boîtier ESP32" hint="Événements remontés par MQTT, par type.">
              {Object.keys(stats.boxCount).length ? (
                <HBars
                  rows={Object.entries(stats.boxCount)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 8)
                    .map(([k, v]) => ({ label: BOX_EVENT_LABEL[k] ?? k, value: v }))}
                />
              ) : (
                <Empty>Aucun événement du boîtier (allumez l’ESP32 dans Wokwi).</Empty>
              )}
            </Card>
            <Card title="Latence plateforme ↔ boîtier" hint="Aller-retour MQTT en millisecondes. Pointillés : objectif temps réel (300 ms).">
              <LineChart points={logs.latency.slice(-60).map((l) => ({ at: l.at, v: l.ms }))} unit=" ms" refLine={{ v: 300, label: "300 ms" }} />
            </Card>
          </div>

          {/* ---- Tableau des logs ---- */}
          <section className="rounded-2xl border border-line bg-surface p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold">Derniers logs</h2>
                <p className="text-xs text-muted">Les 150 plus récents, toutes sources confondues.</p>
              </div>
              <Segmented
                value={source}
                options={[
                  ["tout", "Tout"],
                  ["plateforme", "Plateforme"],
                  ["boitier", "Boîtier"],
                  ["conducteur", "Conducteur"],
                ]}
                onPick={setSource}
              />
            </div>
            {rows.length ? (
              <div className="max-h-96 overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-surface text-left text-xs text-muted">
                    <tr>
                      <th className="py-2 pr-3 font-medium">Date</th>
                      <th className="py-2 pr-3 font-medium">Source</th>
                      <th className="py-2 pr-3 font-medium">Type</th>
                      <th className="py-2 pr-3 font-medium">Niveau</th>
                      <th className="py-2 font-medium">Détail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i} className="border-t border-line align-top">
                        <td className="whitespace-nowrap py-1.5 pr-3 font-mono text-xs text-muted">
                          {new Date(r.at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "medium" })}
                        </td>
                        <td className="py-1.5 pr-3 text-soft">
                          {r.source === "plateforme" ? "Plateforme" : r.source === "boitier" ? "Boîtier" : "Conducteur"}
                        </td>
                        <td className="py-1.5 pr-3">{r.type}</td>
                        <td className="py-1.5 pr-3">
                          {r.level != null && r.level >= 0 && r.level <= 3 ? (
                            <span className="flex items-center gap-1.5 whitespace-nowrap text-soft">
                              <span className="h-2 w-2 rounded-full" style={{ background: LEVEL_COLORS[r.level as 0 | 1 | 2 | 3] }} />
                              {r.level} · {LEVELS[r.level].name}
                            </span>
                          ) : (
                            <span className="text-faint">–</span>
                          )}
                        </td>
                        <td className="py-1.5 text-soft">{r.detail || <span className="text-faint">–</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>Aucun log pour ce filtre.</Empty>
            )}
          </section>
        </main>
      )}
    </div>
  );
}
