"use client";

import { useCallback, useEffect, useState } from "react";
import { useT } from "@/lib/i18n/LocaleContext";

type Account = {
  id: string;
  email: string;
  enabled: boolean;
  last_connected_at: string | null;
  last_error: string | null;
  created_at: string;
};

export function GmailAccountsPanel() {
  const t = useT();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadAccounts = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    try {
      const res = await fetch("/api/admin/gmail-accounts", { cache: "no-store" });
      if (!res.ok) throw new Error("load_failed");
      const body = await res.json();
      setAccounts(body.accounts ?? []);
      setError("");
    } catch {
      setError(t("gmail.accounts.loadError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/gmail-accounts", { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error("load_failed");
        return res.json();
      })
      .then((body) => {
        if (cancelled) return;
        setAccounts(body.accounts ?? []);
        setError("");
      })
      .catch(() => {
        if (!cancelled) setError(t("gmail.accounts.loadError"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [t]);

  async function setEnabled(id: string, enabled: boolean) {
    setAccounts((current) =>
      current.map((account) => account.id === id ? { ...account, enabled } : account)
    );
    const res = await fetch("/api/admin/gmail-accounts", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, enabled }),
    });
    if (!res.ok) {
      setError(t("gmail.accounts.saveError"));
      void loadAccounts();
    }
  }

  async function removeAccount(id: string) {
    const res = await fetch(`/api/admin/gmail-accounts?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      setError(t("gmail.accounts.deleteError"));
      return;
    }
    setAccounts((current) => current.filter((account) => account.id !== id));
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-600">{t("gmail.accounts.helper")}</p>
        <a
          href="/api/admin/gmail-accounts/connect"
          className="rounded-md bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          {accounts.length > 0
            ? t("gmail.accounts.connectAnother")
            : t("gmail.accounts.connect")}
        </a>
      </div>

      {error && (
        <div role="alert" className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-slate-500">{t("gmail.accounts.loading")}</p>
      ) : accounts.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-200 px-3 py-4 text-sm text-slate-500">
          {t("gmail.accounts.empty")}
        </p>
      ) : (
        <div className="divide-y divide-slate-100 rounded-md border border-slate-200">
          {accounts.map((account) => (
            <div key={account.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-3">
              <div>
                <p className="text-sm font-medium text-slate-800">{account.email}</p>
                <p className="text-xs text-slate-500">
                  {account.last_error
                    ? t("gmail.accounts.error")
                    : account.last_connected_at
                      ? t("gmail.accounts.connected")
                      : t("gmail.accounts.pending")}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <label className="inline-flex items-center gap-2 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    checked={account.enabled}
                    onChange={(e) => void setEnabled(account.id, e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  {t("gmail.accounts.enabled")}
                </label>
                <button
                  type="button"
                  onClick={() => void removeAccount(account.id)}
                  className="rounded-md border border-red-200 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
                >
                  {t("gmail.accounts.remove")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
