"use client";

import { useEffect, useState } from "react";

type CustomField = {
  id: string;
  key: string;
  label: string;
  description: string;
  field_type: string;
  claim_type: string | null;
  required: boolean;
  ask_if_missing: boolean;
  enum_values: string[];
  active: boolean;
};

const FIELD_TYPES = ["text", "number", "date", "boolean", "enum", "email", "phone"];
const CLAIM_TYPES = [
  "", "choque", "robo", "granizo", "incendio", "other",
  "cristales", "rc", "robo_contenido", "accidente_personal",
];

async function fetchFields(): Promise<CustomField[]> {
  const res = await fetch("/api/admin/custom-fields", { cache: "no-store" });
  if (!res.ok) throw new Error("load_failed");
  const body = await res.json();
  return body.fields ?? [];
}

export function CustomFieldsPanel() {
  const [fields, setFields] = useState<CustomField[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    key: "",
    label: "",
    description: "",
    field_type: "text",
    claim_type: "",
    required: false,
    ask_if_missing: false,
    enum_values: "",
  });

  useEffect(() => {
    let cancelled = false;
    fetchFields()
      .then((data) => {
        if (!cancelled) setFields(data);
      })
      .catch(() => {
        if (!cancelled) setError("No se pudieron cargar los campos.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function reload() {
    setFields(await fetchFields());
  }

  async function createField(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/admin/custom-fields", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          key: form.key.trim(),
          label: form.label.trim(),
          description: form.description.trim(),
          claim_type: form.claim_type || null,
          enum_values: form.enum_values
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean),
        }),
      });
      if (!res.ok) throw new Error("save_failed");
      setForm({
        key: "",
        label: "",
        description: "",
        field_type: "text",
        claim_type: "",
        required: false,
        ask_if_missing: false,
        enum_values: "",
      });
      await reload();
    } catch {
      setError("No se pudo guardar el campo.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleField(field: CustomField) {
    setError("");
    const res = await fetch(`/api/admin/custom-fields/${field.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !field.active }),
    });
    if (!res.ok) {
      setError("No se pudo actualizar el campo.");
      return;
    }
    await reload();
  }

  if (loading) return <p className="text-sm text-slate-500">Cargando...</p>;

  return (
    <div className="space-y-5">
      <form onSubmit={createField} className="grid gap-3 lg:grid-cols-[1fr_1fr_140px_140px]">
        <input
          value={form.key}
          onChange={(e) => setForm((prev) => ({ ...prev, key: e.target.value }))}
          placeholder="clave_campo"
          className="rounded-md border border-slate-200 px-3 py-2 text-sm"
        />
        <input
          value={form.label}
          onChange={(e) => setForm((prev) => ({ ...prev, label: e.target.value }))}
          placeholder="Etiqueta"
          className="rounded-md border border-slate-200 px-3 py-2 text-sm"
        />
        <select
          value={form.field_type}
          onChange={(e) => setForm((prev) => ({ ...prev, field_type: e.target.value }))}
          className="rounded-md border border-slate-200 px-3 py-2 text-sm"
        >
          {FIELD_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
        <select
          value={form.claim_type}
          onChange={(e) => setForm((prev) => ({ ...prev, claim_type: e.target.value }))}
          className="rounded-md border border-slate-200 px-3 py-2 text-sm"
        >
          {CLAIM_TYPES.map((type) => (
            <option key={type || "all"} value={type}>
              {type || "todos"}
            </option>
          ))}
        </select>
        <input
          value={form.description}
          onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
          placeholder="Descripcion"
          className="rounded-md border border-slate-200 px-3 py-2 text-sm lg:col-span-2"
        />
        <input
          value={form.enum_values}
          onChange={(e) => setForm((prev) => ({ ...prev, enum_values: e.target.value }))}
          placeholder="opciones, separadas, por coma"
          className="rounded-md border border-slate-200 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={saving}
          className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {saving ? "Guardando..." : "Agregar"}
        </button>
        <label className="inline-flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={form.required}
            onChange={(e) => setForm((prev) => ({ ...prev, required: e.target.checked }))}
          />
          Requerido
        </label>
        <label className="inline-flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={form.ask_if_missing}
            onChange={(e) => setForm((prev) => ({ ...prev, ask_if_missing: e.target.checked }))}
          />
          Pedir si falta
        </label>
      </form>

      {error && <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}

      <div className="overflow-hidden rounded-lg border border-slate-200">
        <table className="min-w-full divide-y divide-slate-100 text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Clave</th>
              <th className="px-3 py-2 text-left font-medium">Etiqueta</th>
              <th className="px-3 py-2 text-left font-medium">Tipo</th>
              <th className="px-3 py-2 text-left font-medium">Siniestro</th>
              <th className="px-3 py-2 text-left font-medium">Estado</th>
              <th className="px-3 py-2 text-right font-medium">Accion</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {fields.map((field) => (
              <tr key={field.id}>
                <td className="px-3 py-2 font-mono text-xs">{field.key}</td>
                <td className="px-3 py-2">{field.label}</td>
                <td className="px-3 py-2 text-slate-500">{field.field_type}</td>
                <td className="px-3 py-2 text-slate-500">{field.claim_type ?? "todos"}</td>
                <td className="px-3 py-2">
                  {field.active ? "Activo" : "Inactivo"}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => toggleField(field)}
                    className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50"
                  >
                    {field.active ? "Desactivar" : "Activar"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
