"use client";

import { useEffect, useRef, type RefObject } from "react";

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
};

type Props = {
  buffer: RefObject<ChartSample[]>;
  value: "ear" | "mar" | "eyeProb" | "yawnProb";
  max: number;
  color: string;
  label: string;
  windowS?: number;
};

/** Courbe temps réel dessinée sur un canvas (sans re-rendu React à chaque image). */
export default function LiveChart({ buffer, value, max, color, label, windowS = 15 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const padL = 34;
      const padB = 16;
      const plotW = w - padL - 6;
      const plotH = h - padB - 6;
      const y = (v: number) => 6 + plotH - (Math.min(v, max) / max) * plotH;

      // Grille
      ctx.strokeStyle = "rgba(141,153,174,0.18)";
      ctx.fillStyle = "rgba(141,153,174,0.8)";
      ctx.font = "10px ui-sans-serif, system-ui";
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const v = (max / 4) * i;
        ctx.beginPath();
        ctx.moveTo(padL, y(v));
        ctx.lineTo(padL + plotW, y(v));
        ctx.stroke();
        ctx.fillText(v.toFixed(2), 2, y(v) + 3);
      }
      ctx.fillText(`-${windowS} s`, padL, h - 3);
      ctx.fillText("maintenant", padL + plotW - 58, h - 3);

      const data = buffer.current;
      if (!data || data.length < 2) return;
      const tEnd = data[data.length - 1].t;
      const x = (t: number) => padL + plotW - ((tEnd - t) / windowS) * plotW;
      const visible = data.filter((d) => tEnd - d.t <= windowS);

      // Zones « yeux fermés » (seulement sur la courbe EAR)
      if (value === "ear" || value === "eyeProb") {
        ctx.fillStyle = "rgba(231,111,81,0.18)";
        for (let i = 1; i < visible.length; i++) {
          if (visible[i].closed) ctx.fillRect(x(visible[i - 1].t), 6, x(visible[i].t) - x(visible[i - 1].t) + 0.5, plotH);
        }
      }

      // Seuil
      const thrKey = ({ ear: "earThr", mar: "marThr", eyeProb: "eyeThr", yawnProb: "yawnThr" } as const)[value];
      ctx.strokeStyle = "#F2A541";
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      visible.forEach((d, i) => (i ? ctx.lineTo(x(d.t), y(d[thrKey])) : ctx.moveTo(x(d.t), y(d[thrKey]))));
      ctx.stroke();
      ctx.setLineDash([]);

      // Courbe
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      visible.forEach((d, i) => (i ? ctx.lineTo(x(d.t), y(d[value])) : ctx.moveTo(x(d.t), y(d[value]))));
      ctx.stroke();
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [buffer, value, max, color, windowS]);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-xs text-slate-400">
        <span>{label}</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="inline-block h-0.5 w-4" style={{ background: color }} /> mesure
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-0 w-4 border-t-2 border-dashed border-[#F2A541]" /> seuil
          </span>
        </span>
      </div>
      <canvas ref={canvasRef} className="h-32 w-full" />
    </div>
  );
}
