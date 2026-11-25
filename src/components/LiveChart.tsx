"use client";

import { useEffect, useRef, type RefObject } from "react";
import { C } from "@/lib/theme";

export type ChartSample = {
  t: number;
  ear: number;
  earThr: number;
  mar: number;
  marThr: number;
  eyeProb: number;
  eyeThr: number;
  yawnProb: number;
  yawnThr: number;
  closed: boolean;
  yawning: boolean;
};

type Value = "ear" | "mar" | "eyeProb" | "yawnProb";

type Props = {
  buffer: RefObject<ChartSample[]>;
  value: Value;
  max: number;
  color: string;
  title: string;
  /** Explication courte sous le titre. */
  hint: string;
  /** « below » : l'alerte est sous le seuil (EAR) ; « above » : au-dessus (MAR, probabilités). */
  alarm: "below" | "above";
  /** Libellés de l'état normal / anormal affichés dans la pastille. */
  states: readonly [string, string];
  digits?: number;
  windowS?: number;
};

const THR_KEY = { ear: "earThr", mar: "marThr", eyeProb: "eyeThr", yawnProb: "yawnThr" } as const;
const FLAG_KEY = { ear: "closed", eyeProb: "closed", mar: "yawning", yawnProb: "yawning" } as const;

function rgba(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

/**
 * Courbe temps réel dessinée sur un canvas (aucun re-rendu React à chaque image).
 * Valeur actuelle et état en haut, zone d'alerte teintée, seuil en pointillés,
 * survol : ligne verticale + valeur à l'instant pointé.
 */
export default function LiveChart({ buffer, value, max, color, title, hint, alarm, states, digits = 2, windowS = 15 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const valueRef = useRef<HTMLSpanElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const hoverRef = useRef<number | null>(null); // x de la souris (px CSS)

  useEffect(() => {
    let raf = 0;
    let lastKey = "";
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const data = buffer.current ?? [];
      const last = data[data.length - 1];
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      // Redessiner seulement si quelque chose a changé (nouvelle image, souris, taille).
      const key = `${last?.t ?? 0}|${hoverRef.current ?? ""}|${w}x${h}`;
      if (key === lastKey) return;
      lastKey = key;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const padL = 36;
      const padR = 10;
      const padT = 8;
      const padB = 20;
      const plotW = w - padL - padR;
      const plotH = h - padT - padB;
      const y = (v: number) => padT + plotH - (Math.max(0, Math.min(v, max)) / max) * plotH;
      const tEnd = last?.t ?? 0;
      const x = (t: number) => padL + plotW - ((tEnd - t) / windowS) * plotW;

      // Grille et axes (discrets)
      ctx.font = "11px ui-sans-serif, system-ui";
      ctx.lineWidth = 1;
      ctx.textBaseline = "middle";
      for (let i = 0; i <= 4; i++) {
        const v = (max / 4) * i;
        ctx.strokeStyle = rgba(C.line, i === 0 ? 1 : 0.7);
        ctx.beginPath();
        ctx.moveTo(padL, Math.round(y(v)) + 0.5);
        ctx.lineTo(padL + plotW, Math.round(y(v)) + 0.5);
        ctx.stroke();
        ctx.fillStyle = C.muted;
        ctx.textAlign = "right";
        ctx.fillText(v.toFixed(max <= 1 ? 2 : 1), padL - 6, y(v));
      }
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "center";
      for (let s = 0; s <= windowS; s += 5) {
        const px = padL + plotW - (s / windowS) * plotW;
        ctx.fillStyle = C.muted;
        ctx.fillText(s === 0 ? "maintenant" : `-${s} s`, Math.min(Math.max(px, padL + 14), padL + plotW - 30), h - 5);
      }

      if (!last) {
        ctx.fillStyle = C.faint;
        ctx.fillText("En attente de la caméra…", padL + plotW / 2, padT + plotH / 2);
        if (valueRef.current) valueRef.current.textContent = "–";
        if (pillRef.current) pillRef.current.style.visibility = "hidden";
        return;
      }

      const visible = data.filter((d) => tEnd - d.t <= windowS);
      const thrKey = THR_KEY[value];
      const flagKey = FLAG_KEY[value];
      const thr = last[thrKey];

      // Zone d'alerte (au-delà du seuil), très légère
      ctx.fillStyle = rgba(C.danger, 0.07);
      if (alarm === "below") ctx.fillRect(padL, y(thr), plotW, padT + plotH - y(thr));
      else ctx.fillRect(padL, padT, plotW, y(thr) - padT);

      // Bandes verticales quand l'état anormal est détecté (yeux fermés / bâillement)
      // (une seule bande par période continue : pas de rayures dues aux recouvrements)
      ctx.fillStyle = rgba(C.danger, 0.22);
      let runStart: number | null = null;
      for (let i = 1; i <= visible.length; i++) {
        const on = i < visible.length && visible[i][flagKey];
        if (on && runStart === null) runStart = x(visible[i - 1].t);
        if (!on && runStart !== null) {
          ctx.fillRect(runStart, padT, x(visible[i - 1].t) - runStart, plotH);
          runStart = null;
        }
      }

      // Seuil (pointillés) + étiquette
      ctx.strokeStyle = C.soft;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      visible.forEach((d, i) => (i ? ctx.lineTo(x(d.t), y(d[thrKey])) : ctx.moveTo(x(d.t), y(d[thrKey]))));
      ctx.stroke();
      ctx.setLineDash([]);
      // Étiquette du seuil sur un fond (lisible même quand la courbe passe dessous)
      const thrText = `seuil ${thr.toFixed(digits)}`;
      const thrW = ctx.measureText(thrText).width + 10;
      const thrY = y(thr) + (alarm === "below" ? -18 : 4);
      ctx.fillStyle = rgba(C.surface, 0.9);
      ctx.beginPath();
      ctx.roundRect(padL + plotW - thrW - 2, thrY, thrW, 15, 4);
      ctx.fill();
      ctx.fillStyle = C.soft;
      ctx.textAlign = "right";
      ctx.fillText(thrText, padL + plotW - 7, thrY + 11.5);

      // Aire sous la courbe puis courbe
      const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
      grad.addColorStop(0, rgba(color, 0.28));
      grad.addColorStop(1, rgba(color, 0));
      ctx.beginPath();
      visible.forEach((d, i) => (i ? ctx.lineTo(x(d.t), y(d[value])) : ctx.moveTo(x(d.t), y(d[value]))));
      ctx.lineTo(x(tEnd), padT + plotH);
      ctx.lineTo(x(visible[0].t), padT + plotH);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.beginPath();
      visible.forEach((d, i) => (i ? ctx.lineTo(x(d.t), y(d[value])) : ctx.moveTo(x(d.t), y(d[value]))));
      ctx.stroke();

      // Point « maintenant »
      ctx.fillStyle = color;
      ctx.strokeStyle = C.surface;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x(tEnd), y(last[value]), 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Survol : ligne verticale + valeur
      const hx = hoverRef.current;
      if (hx !== null && hx >= padL && hx <= padL + plotW) {
        const tAt = tEnd - ((padL + plotW - hx) / plotW) * windowS;
        let best = visible[0];
        for (const d of visible) if (Math.abs(d.t - tAt) < Math.abs(best.t - tAt)) best = d;
        const bx = x(best.t);
        ctx.strokeStyle = rgba(C.ink, 0.5);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(bx, padT);
        ctx.lineTo(bx, padT + plotH);
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.strokeStyle = C.surface;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(bx, y(best[value]), 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        const text = `${best[value].toFixed(digits)} · il y a ${(tEnd - best.t).toFixed(1)} s`;
        ctx.font = "12px ui-sans-serif, system-ui";
        const tw = ctx.measureText(text).width + 14;
        const bxBox = Math.min(Math.max(bx - tw / 2, padL), padL + plotW - tw);
        ctx.fillStyle = C.raised;
        ctx.strokeStyle = C.line;
        ctx.beginPath();
        ctx.roundRect(bxBox, padT + 2, tw, 22, 6);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = C.ink;
        ctx.textAlign = "left";
        ctx.fillText(text, bxBox + 7, padT + 17);
      }

      // En-tête : valeur et état actuels (mis à jour sans React)
      if (valueRef.current) valueRef.current.textContent = last[value].toFixed(digits);
      const bad = last[flagKey];
      const pill = pillRef.current;
      if (pill) {
        pill.style.visibility = "visible";
        pill.textContent = bad ? states[1] : states[0];
        pill.style.color = bad ? "#fff" : C.soft;
        pill.style.background = bad ? C.danger : rgba(C.ink, 0.06);
      }
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [buffer, value, max, color, windowS, alarm, digits, states]);

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line bg-raised/60 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-semibold text-ink">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} />
            {title}
          </p>
          <p className="text-xs text-muted">{hint}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span ref={pillRef} className="invisible rounded-full px-2 py-0.5 text-xs font-semibold" />
          <span ref={valueRef} className="min-w-14 text-right font-mono text-2xl font-semibold tabular-nums text-ink">
            –
          </span>
        </div>
      </div>
      <canvas
        ref={canvasRef}
        className="h-44 w-full cursor-crosshair"
        onMouseMove={(e) => {
          hoverRef.current = e.clientX - e.currentTarget.getBoundingClientRect().left;
        }}
        onMouseLeave={() => {
          hoverRef.current = null;
        }}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 rounded" style={{ background: color }} /> mesure
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-4 border-t-2 border-dashed border-soft" /> seuil
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-sm" style={{ background: rgba(C.danger, 0.35) }} /> {states[1].toLowerCase()}
        </span>
      </div>
    </div>
  );
}
