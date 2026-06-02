/**
 * Toast notification component for realtime updates.
 *
 * AC12: Shows subtle toast for new cases and status changes.
 * Design: bottom-right position, auto-dismiss after 4 seconds.
 */

"use client";

import { useEffect, useState, useCallback } from "react";

export interface ToastMessage {
  id: string;
  message: string;
  type?: "info" | "success" | "error";
}

interface ToastProps {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: ToastMessage;
  onDismiss: (id: string) => void;
}) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), 4000);
    return () => clearTimeout(timer);
  }, [toast.id, onDismiss]);

  const bgClass =
    toast.type === "error"
      ? "bg-red-50 border-red-200 text-red-900"
      : toast.type === "success"
      ? "bg-green-50 border-green-200 text-green-900"
      : "bg-white border-slate-200 text-slate-900";

  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-start justify-between gap-3 rounded-lg border px-4 py-3 shadow-md text-sm animate-in slide-in-from-bottom-2 ${bgClass}`}
    >
      <span>{toast.message}</span>
      <button
        onClick={() => onDismiss(toast.id)}
        aria-label="Cerrar notificación"
        className="ml-2 shrink-0 text-slate-400 hover:text-slate-700"
      >
        ✕
      </button>
    </div>
  );
}

export function ToastContainer({ toasts, onDismiss }: ToastProps) {
  if (toasts.length === 0) return null;

  return (
    <div
      aria-label="Notificaciones"
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-80"
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

/**
 * Hook to manage toast state.
 */
export function useToast() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const addToast = useCallback((message: string, type: ToastMessage["type"] = "info") => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, message, type }]);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { toasts, addToast, dismissToast };
}
