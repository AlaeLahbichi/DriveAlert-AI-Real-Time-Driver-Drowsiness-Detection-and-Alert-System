"use client";

// Petits graphiques du tableau de bord (HTML + SVG, sans librairie) avec infobulle au survol.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { C } from "@/lib/theme";

/* ---------- Infobulle ---------- */

type Tip = { x: number; y: number; content: ReactNode } | null;

/** Infobulle positionnée par rapport au conteneur marqué data-tip-root. */
function useTip() {
  const [tip, setTip] = useState<Tip>(null);
  const show = (e: React.MouseEvent, content: ReactNode) => {
    const r = (e.currentTarget as HTMLElement).closest("[data-tip-root]")?.getBoundingClientRect();
    if (r) setTip({ x: e.clientX - r.left, y: e.clientY - r.top, content });
  };
  const hide = () => setTip(null);
  const node = tip && (
    <div
      className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-line bg-raised px-2.5 py-1.5 text-xs text-ink shadow-xl"
      style={{ left: tip.x, top: tip.y - 10 }}
    >
      {tip.content}
    </div>
  );
  return { show, hide, node };
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, w };
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="flex h-32 items-center justify-center text-center text-sm text-faint">{children}</p>;
}

/** Graduation « ronde » pour l'axe des valeurs. */
function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

/* ---------- Barres horizontales (classement) ---------- */

export function HBars({ rows, unit = "" }: { rows: { label: string; value: number; color?: string }[]; unit?: string }) {
  const tip = useTip();
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div data-tip-root className="relative flex flex-col gap-2.5">
      {rows.map((r) => (
        <div
          key={r.label}
          className="group grid grid-cols-[8.5rem_1fr_3rem] items-center gap-3 text-sm"
          onMouseMove={(e) => tip.show(e, <><b>{r.label}</b> · {r.value}{unit}</>)}
          onMouseLeave={tip.hide}
        >
          <span className="truncate text-soft">{r.label}</span>
          <div className="h-3.5 rounded bg-raised">
            <div
              className="h-full rounded transition-all group-hover:brightness-125"
              style={{ width: `${(r.value / max) * 100}%`, minWidth: r.value ? 4 : 0, background: r.color ?? C.brand }}
            />
          </div>
          <span className="text-right font-mono tabular-nums text-ink">{r.value}{unit}</span>
        </div>
      ))}
      {tip.node}
    </div>
  );
}

/* ---------- Barre empilée 100 % (répartition) ---------- */

export function StackBar100({ parts }: { parts: { label: string; value: number; color: string; display: string }[] }) {
  const tip = useTip();
  const total = parts.reduce((s, p) => s + p.value, 0);
  if (!total) return <Empty>Pas encore de temps de surveillance enregistré.</Empty>;
  return (
    <div data-tip-root className="relative">
      <div className="flex h-9 gap-0.5 overflow-hidden rounded-lg">
        {parts
          .filter((p) => p.value > 0)
          .map((p) => (
            <div
              key={p.label}
              className="flex h-full items-center justify-center text-xs font-bold text-black transition hover:brightness-110"
              style={{ width: `${(p.value / total) * 100}%`, background: p.color }}
              onMouseMove={(e) => tip.show(e, <><b>{p.label}</b> · {((p.value / total) * 100).toFixed(1)} % · {p.display}</>)}
              onMouseLeave={tip.hide}
            >
              {p.value / total > 0.08 ? `${Math.round((p.value / total) * 100)} %` : ""}
            </div>
          ))}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {parts.map((p) => (
          <div key={p.label} className="flex items-start gap-2 text-xs">
            <span className="mt-0.5 h-3 w-3 shrink-0 rounded-sm" style={{ background: p.color }} />
            <span>
              <span className="text-soft">{p.label}</span>
              <span className="block font-mono text-ink">
                {((p.value / total) * 100).toFixed(1)} % · {p.display}
              </span>
            </span>
          </div>
        ))}
      </div>
      {tip.node}
    </div>
  );
}

/* ---------- Colonnes (empilées ou non) ---------- */

export type ColumnSeries = { key: string; label: string; color: string };

export function Columns({
  data,
  series,
  height = 180,
  unit = "",
}: {
  data: { label: string; title?: string; values: Record<string, number> }[];
  series: ColumnSeries[];
  height?: number;
  unit?: string;
}) {
  const tip = useTip();
  const totals = data.map((d) => series.reduce((s, k) => s + (d.values[k.key] ?? 0), 0));
  const max = niceMax(Math.max(0, ...totals));
  const ticks = [0, 0.5, 1].map((f) => f * max);
  const showEvery = Math.ceil(data.length / 12);
  return (
    <div data-tip-root className="relative">
      {series.length > 1 && (
        <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-soft">
          {series.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-sm" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <div className="flex">
        <div className="relative w-8 shrink-0 text-right text-[11px] text-muted" style={{ height }}>
          {ticks.map((t) => (
            <span key={t} className="absolute right-2 -translate-y-1/2" style={{ top: height - (t / max) * height }}>
              {Number.isInteger(t) ? t : t.toFixed(1)}
            </span>
          ))}
        </div>
        <div className="relative flex-1">
          {ticks.map((t) => (
            <div key={t} className="absolute inset-x-0 border-t border-line" style={{ top: height - (t / max) * height }} />
          ))}
          <div className="relative flex items-end gap-1" style={{ height }}>
            {data.map((d, i) => (
              <div
                key={i}
                className="group flex h-full flex-1 flex-col justify-end"
                onMouseMove={(e) =>
                  tip.show(
                    e,
                    <div>
                      <p className="mb-0.5 font-semibold">{d.title ?? d.label}</p>
                      {series.map((s) => (
                        <p key={s.key} className="flex items-center gap-1.5">
                          <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />
                          {s.label} : <b>{d.values[s.key] ?? 0}{unit}</b>
                        </p>
                      ))}
                    </div>,
                  )
                }
                onMouseLeave={tip.hide}
              >
                <div className="mx-auto flex w-full max-w-10 flex-col-reverse gap-0.5 group-hover:brightness-125">
                  {series.map((s) => {
                    const v = d.values[s.key] ?? 0;
                    if (!v) return null;
                    return <div key={s.key} className="w-full rounded-[3px]" style={{ height: (v / max) * height - 2, background: s.color }} />;
                  })}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-1.5 flex gap-1 text-[11px] text-muted">
            {data.map((d, i) => (
              <span key={i} className="flex-1 truncate text-center">
                {i % showEvery === 0 ? d.label : ""}
              </span>
            ))}
          </div>
        </div>
      </div>
      {tip.node}
    </div>
  );
}

/* ---------- Courbe (latence) ---------- */

export function LineChart({
  points,
  color = C.brand,
  unit = "",
  height = 170,
  refLine,
}: {
  points: { at: number; v: number }[];
  color?: string;
  unit?: string;
  height?: number;
  refLine?: { v: number; label: string };
}) {
  const { ref, w } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  if (points.length < 2) return <Empty>Pas assez de mesures (bouton « Tester » dans l’onglet Boîtier IoT).</Empty>;
  const padL = 40;
  const padB = 20;
  const padT = 10;
  const pw = Math.max(10, w - padL - 8);
  const ph = height - padB - padT;
  const max = niceMax(Math.max(...points.map((p) => p.v)) * 1.1);
  const x = (i: number) => padL + (i / (points.length - 1)) * pw;
  const y = (v: number) => padT + ph - (v / max) * ph;
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.v)}`).join("");
  const h = hover !== null ? points[hover] : null;
  return (
    <div ref={ref} className="relative">
      {w > 0 && (
        <svg
          width={w}
          height={height}
          className="block"
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const i = Math.round(((e.clientX - r.left - padL) / pw) * (points.length - 1));
            setHover(Math.max(0, Math.min(points.length - 1, i)));
          }}
          onMouseLeave={() => setHover(null)}
        >
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={padL} x2={padL + pw} y1={y(f * max)} y2={y(f * max)} stroke={C.line} />
              <text x={padL - 6} y={y(f * max) + 4} textAnchor="end" fontSize="11" fill={C.muted}>
                {Math.round(f * max)}
              </text>
            </g>
          ))}
          {refLine && (
            <g>
              <line x1={padL} x2={padL + pw} y1={y(refLine.v)} y2={y(refLine.v)} stroke={C.soft} strokeDasharray="6 4" />
              <text x={padL + pw - 2} y={y(refLine.v) - 5} textAnchor="end" fontSize="11" fill={C.soft}>
                {refLine.label}
              </text>
            </g>
          )}
          <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
          <text x={padL} y={height - 4} fontSize="11" fill={C.muted}>
            {new Date(points[0].at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}
          </text>
          <text x={padL + pw} y={height - 4} textAnchor="end" fontSize="11" fill={C.muted}>
            {new Date(points[points.length - 1].at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}
          </text>
          {h && hover !== null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + ph} stroke={C.soft} strokeOpacity={0.5} />
              <circle cx={x(hover)} cy={y(h.v)} r={4.5} fill={color} stroke={C.surface} strokeWidth={2} />
            </g>
          )}
        </svg>
      )}
      {h && hover !== null && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-line bg-raised px-2.5 py-1.5 text-xs shadow-xl"
          style={{ left: x(hover), top: y(h.v) - 10 }}
        >
          <b>{Math.round(h.v)}{unit}</b> · {new Date(h.at).toLocaleTimeString("fr-FR")}
        </div>
      )}
    </div>
  );
}

/* ---------- Chronologie des niveaux (marches) ---------- */

export function LevelTimeline({
  timeline,
  start,
  end,
  colors,
  names,
}: {
  timeline: { at: number; level: number }[];
  start: number;
  end: number;
  colors: Record<number, string>;
  names: string[];
}) {
  const { ref, w } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ x: number; i: number } | null>(null);
  const height = 150;
  const padL = 86;
  const padB = 20;
  const pw = Math.max(10, w - padL - 8);
  const rowH = (height - padB) / 4;
  const span = Math.max(1, end - start);
  const x = (t: number) => padL + ((t - start) / span) * pw;
  const yRow = (l: number) => (3 - l) * rowH;
  const segs = timeline.map((p, i) => ({ ...p, to: timeline[i + 1]?.at ?? end }));
  const fmt = (ms: number) => {
    const s = Math.round(ms / 1000);
    return s >= 60 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s` : `${s} s`;
  };
  const hs = hover ? segs[hover.i] : null;
  return (
    <div ref={ref} className="relative">
      {w > 0 && (
        <svg width={w} height={height} className="block" onMouseLeave={() => setHover(null)}>
          {[0, 1, 2, 3].map((l) => (
            <g key={l}>
              <rect x={padL} y={yRow(l) + 1} width={pw} height={rowH - 2} fill={C.raised} rx={4} />
              <circle cx={8} cy={yRow(l) + rowH / 2} r={4} fill={colors[l]} />
              <text x={18} y={yRow(l) + rowH / 2 + 4} fontSize="11" fill={C.soft}>
                {l} · {names[l]}
              </text>
            </g>
          ))}
          {segs.map((s, i) => (
            <rect
              key={i}
              x={x(s.at)}
              y={yRow(s.level) + 4}
              width={Math.max(2, x(s.to) - x(s.at) - 1)}
              height={rowH - 8}
              rx={3}
              fill={colors[s.level]}
              onMouseMove={(e) => {
                const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                setHover({ x: e.clientX - r.left, i });
              }}
            />
          ))}
          <text x={padL} y={height - 4} fontSize="11" fill={C.muted}>
            {new Date(start).toLocaleTimeString("fr-FR")}
          </text>
          <text x={padL + pw} y={height - 4} textAnchor="end" fontSize="11" fill={C.muted}>
            {new Date(end).toLocaleTimeString("fr-FR")} · durée {fmt(span)}
          </text>
        </svg>
      )}
      {hs && hover && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-line bg-raised px-2.5 py-1.5 text-xs shadow-xl"
          style={{ left: hover.x, top: yRow(hs.level) }}
        >
          <b>{names[hs.level]}</b> · {new Date(hs.at).toLocaleTimeString("fr-FR")} → {new Date(hs.to).toLocaleTimeString("fr-FR")} ({fmt(hs.to - hs.at)})
        </div>
      )}
    </div>
  );
}
