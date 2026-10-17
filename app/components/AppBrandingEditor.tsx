"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  APP_ICON_PRESETS,
  ORIGINAL_APP_ICON,
  ORIGINAL_LOGO_SRC,
  appIconSrc,
  isImageAppIcon,
  type AppBranding,
} from "@/app/lib/appBranding";

type AppBrandingEditorProps = {
  value: AppBranding;
  onSaved: (next: AppBranding) => Promise<void> | void;
};

const readFileAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("קריאת הקובץ נכשלה"));
    reader.readAsDataURL(file);
  });

export const AppIconView = ({ icon, size = 36, className = "" }: { icon: string; size?: number; className?: string }) => {
  if (isImageAppIcon(icon)) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={appIconSrc(icon)}
        alt=""
        width={size}
        height={size}
        className={`rounded-xl object-cover bg-white ${className}`}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className={`inline-flex items-center justify-center rounded-xl bg-white ${className}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.62) }}
      aria-hidden
    >
      {icon || "📅"}
    </span>
  );
};

export default function AppBrandingEditor({ value, onSaved }: AppBrandingEditorProps) {
  const [title, setTitle] = useState(value.app_title);
  const [icon, setIcon] = useState(value.app_icon);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setTitle(value.app_title);
    setIcon(value.app_icon);
    setError("");
  }, [value.app_title, value.app_icon]);

  const dirty = title.trim() !== value.app_title || icon !== value.app_icon;

  const handleCancel = () => {
    setTitle(value.app_title);
    setIcon(value.app_icon);
    setError("");
  };

  const handleSave = async () => {
    setBusy(true);
    setError("");
    try {
      await onSaved({ app_title: title.trim(), app_icon: icon });
    } catch (err) {
      setError(err instanceof Error ? err.message : "שמירת עיצוב הלוח נכשלה");
    } finally {
      setBusy(false);
    }
  };

  const handleUpload = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("יש לבחור קובץ תמונה.");
      return;
    }
    if (file.size > 120_000) {
      setError("התמונה גדולה מדי (עד 120KB).");
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      setIcon(dataUrl);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "העלאת התמונה נכשלה");
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-3">
      <div className="text-sm font-bold text-slate-800">שם הלוח ואייקון</div>
      <div className="flex items-center gap-2">
        <AppIconView icon={icon} size={40} />
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={80}
          placeholder="הלו״ז המשפחתי שלנו"
          className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400"
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {APP_ICON_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => setIcon(preset)}
            className={`h-9 w-9 rounded-lg border bg-white text-lg ${
              icon === preset ? "border-slate-800 ring-2 ring-slate-400" : "border-slate-200 hover:bg-slate-50"
            }`}
            aria-label={preset}
          >
            {preset}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setIcon(ORIGINAL_APP_ICON)}
          className={`h-9 w-9 rounded-lg border bg-white overflow-hidden ${
            icon === ORIGINAL_APP_ICON ? "border-slate-800 ring-2 ring-slate-400" : "border-slate-200 hover:bg-slate-50"
          }`}
          aria-label="לוגו מקורי"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={ORIGINAL_LOGO_SRC} alt="" className="h-full w-full object-cover" />
        </button>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
        >
          העלאת תמונה
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            void handleUpload(file);
          }}
        />
      </div>
      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{error}</div>
      ) : null}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => { void handleSave(); }}
          disabled={busy || !dirty}
          className="flex-1 rounded-lg bg-slate-800 px-3 py-2 text-sm font-bold text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {busy ? "שומר..." : "שמירה"}
        </button>
        <button
          type="button"
          onClick={handleCancel}
          disabled={busy || !dirty}
          className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          ביטול
        </button>
      </div>
    </div>
  );
}
