"use client";

import { useState } from "react";

interface Props {
  initialHasKey: boolean;
}

export function UserAiKeyPanel({ initialHasKey }: Props) {
  const [hasKey, setHasKey] = useState(initialHasKey);
  const [showForm, setShowForm] = useState(false);
  const [keyValue, setKeyValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function saveKey() {
    if (!keyValue.trim()) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/user/ai-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ geminiKey: keyValue.trim() }),
      });
      if (!res.ok) throw new Error("save_failed");
      setHasKey(true);
      setShowForm(false);
      setKeyValue("");
      setSaved(true);
    } catch {
      setError("No se pudo guardar la clave. Intentá de nuevo.");
    } finally {
      setSaving(false);
    }
  }

  async function clearKey() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/user/ai-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clearGeminiKey: true }),
      });
      if (!res.ok) throw new Error("clear_failed");
      setHasKey(false);
      setSaved(false);
    } catch {
      setError("No se pudo eliminar la clave.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-slate-700">
            Gemini API Key{" "}
            <span className="text-xs text-slate-400">(personal — solo usada para tus casos)</span>
          </p>
          {hasKey ? (
            <p className="mt-0.5 text-xs text-emerald-600">✓ Configurada</p>
          ) : (
            <p className="mt-0.5 text-xs text-slate-400">No configurada</p>
          )}
        </div>
        <div className="flex gap-2">
          {hasKey && (
            <button
              onClick={clearKey}
              disabled={saving}
              className="text-xs text-red-500 hover:underline disabled:opacity-50"
            >
              Eliminar
            </button>
          )}
          <button
            onClick={() => { setShowForm(!showForm); setSaved(false); setError(null); }}
            className="rounded border border-slate-200 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
          >
            {hasKey ? "Actualizar clave" : "Agregar clave"}
          </button>
        </div>
      </div>

      {showForm && (
        <div className="space-y-2 rounded border border-slate-200 bg-slate-50 p-3">
          <label className="block text-xs font-medium text-slate-600">
            Google Gemini API Key
          </label>
          <input
            type="password"
            value={keyValue}
            onChange={(e) => setKeyValue(e.target.value)}
            placeholder="AIza..."
            className="w-full rounded border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-800 focus:border-blue-500 focus:outline-none"
          />
          <p className="text-xs text-slate-400">
            Obtené tu clave en{" "}
            <a
              href="https://aistudio.google.com/app/apikey"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-500 hover:underline"
            >
              Google AI Studio
            </a>
            . Se almacena cifrada y nunca se comparte.
          </p>
          {error && <p className="text-xs text-red-500">{error}</p>}
          <div className="flex gap-2">
            <button
              onClick={saveKey}
              disabled={saving || !keyValue.trim()}
              className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? "Guardando..." : "Guardar"}
            </button>
            <button
              onClick={() => { setShowForm(false); setKeyValue(""); setError(null); }}
              className="rounded border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {saved && !showForm && (
        <p className="text-xs text-emerald-600">Clave guardada correctamente.</p>
      )}
    </div>
  );
}
