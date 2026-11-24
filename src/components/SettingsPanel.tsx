"use client";

import type { Settings } from "@/lib/engine";

type NumKey = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];

const SLIDERS: { key: NumKey; label: string; min: number; max: number; step: number; unit?: string }[] = [
  { key: "earRatio", label: "Seuil EAR (× valeur calibrée)", min: 0.5, max: 0.95, step: 0.05 },
  { key: "earDefault", label: "Seuil EAR sans calibration", min: 0.1, max: 0.35, step: 0.01 },
  { key: "blinkScoreThreshold", label: "Seuil score eyeBlink (Google)", min: 0.2, max: 0.9, step: 0.05 },
  { key: "closedAlertS", label: "Yeux fermés → Alerte", min: 0.5, max: 3, step: 0.1, unit: "s" },
  { key: "closedDangerS", label: "Yeux fermés → Danger", min: 1, max: 5, step: 0.1, unit: "s" },
  { key: "marThreshold", label: "Seuil MAR (bâillement)", min: 0.3, max: 1, step: 0.05 },
  { key: "yawnMinS", label: "Durée min. d'un bâillement", min: 0.5, max: 4, step: 0.1, unit: "s" },
  { key: "pitchDeg", label: "Écart tête (hochement)", min: 8, max: 40, step: 1, unit: "°" },
  { key: "yawDeg", label: "Écart tête (distraction)", min: 15, max: 60, step: 1, unit: "°" },
  { key: "perclosWarn", label: "PERCLOS → Vigilance", min: 0.05, max: 0.5, step: 0.01 },
  { key: "perclosAlert", label: "PERCLOS → Alerte", min: 0.1, max: 0.7, step: 0.01 },
];

type Props = { settings: Settings; onChange: (s: Settings) => void; onReset: () => void; withModel?: boolean };

const MODEL_SLIDERS: typeof SLIDERS = [
  { key: "modelEyeThreshold", label: "Mon modèle : seuil yeux fermés", min: 0.1, max: 0.95, step: 0.05 },
  { key: "modelYawnThreshold", label: "Mon modèle : seuil bâillement", min: 0.1, max: 0.95, step: 0.05 },
];

function Choice<T extends string>({ title, value, options, onPick }: {
  title: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onPick: (v: T) => void;
}) {
  return (
    <div>
      <p className="mb-2 text-xs text-slate-400">{title}</p>
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
        {options.map(([v, label]) => (
          <button
            key={v}
            onClick={() => onPick(v)}
            className={`rounded-lg border px-3 py-2 text-sm transition ${
              value === v ? "border-[#2A9D8F] bg-[#2A9D8F]/20 text-white" : "border-white/10 text-slate-300 hover:border-white/30"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function SettingsPanel({ settings, onChange, onReset, withModel = false }: Props) {
  const sliders = withModel ? [...MODEL_SLIDERS, ...SLIDERS] : SLIDERS;
  return (
    <div className="flex flex-col gap-4">
      <Choice
        title="Comment décider que les yeux sont fermés"
        value={settings.eyeSource}
        options={
          withModel
            ? ([["model", "Mon modèle"], ["ear", "EAR (géométrie)"], ["blendshape", "Score eyeBlink (Google)"]] as const)
            : ([["ear", "EAR (géométrie)"], ["blendshape", "Score eyeBlink (Google)"]] as const)
        }
        onPick={(v) => onChange({ ...settings, eyeSource: v })}
      />
      {withModel && (
        <Choice
          title="Comment décider qu’il y a un bâillement"
          value={settings.mouthSource}
          options={[["model", "Mon modèle"], ["mar", "MAR (géométrie)"]] as const}
          onPick={(v) => onChange({ ...settings, mouthSource: v })}
        />
      )}

      <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        {sliders.map(({ key, label, min, max, step, unit }) => (
          <label key={key} className="flex flex-col gap-1 text-xs text-slate-300">
            <span className="flex justify-between">
              <span>{label}</span>
              <span className="font-mono text-white">
                {settings[key].toFixed(step < 0.1 ? 2 : step < 1 ? 1 : 0)}
                {unit ?? ""}
              </span>
            </span>
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={settings[key]}
              onChange={(e) => onChange({ ...settings, [key]: Number(e.target.value) })}
              className="accent-[#F2A541]"
            />
          </label>
        ))}
      </div>

      <button onClick={onReset} className="self-start text-xs text-slate-400 underline hover:text-white">
        Remettre les valeurs par défaut
      </button>
    </div>
  );
}
