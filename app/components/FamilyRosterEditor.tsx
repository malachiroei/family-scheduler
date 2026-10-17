"use client";

import React, { useMemo, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import {
  blankOnboardingMembers,
  COLOR_PALETTE,
  ONBOARDING_PLACEHOLDERS,
  type FamilyMember,
  type FamilyRole,
  type StoredFamilyMember,
} from "@/app/lib/familyMembers";

type DraftRow = {
  id: string;
  name: string;
  role: FamilyRole;
  color: string;
  key?: string;
};

type FamilyRosterEditorProps = {
  title: string;
  subtitle?: string;
  initialMembers: FamilyMember[];
  saveLabel?: string;
  onSave: (members: StoredFamilyMember[]) => Promise<void> | void;
  onClose?: () => void;
  allowClose?: boolean;
  /** Empty generic rows (new tenant) instead of the current household names. */
  blankStart?: boolean;
  requireParentAndChild?: boolean;
};

const newId = () => `new-${Math.random().toString(36).slice(2, 9)}`;

const toDraft = (members: FamilyMember[]): DraftRow[] =>
  members.map((member) => ({
    id: member.key || newId(),
    name: member.name,
    role: member.role,
    color: member.color,
    key: member.key || undefined,
  }));

export default function FamilyRosterEditor({
  title,
  subtitle,
  initialMembers,
  saveLabel = "שמירה",
  onSave,
  onClose,
  allowClose = true,
  blankStart = false,
  requireParentAndChild = false,
}: FamilyRosterEditorProps) {
  const [rows, setRows] = useState<DraftRow[]>(() =>
    toDraft(blankStart ? blankOnboardingMembers() : initialMembers),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const parents = useMemo(() => rows.filter((row) => row.role === "parent"), [rows]);
  const children = useMemo(() => rows.filter((row) => row.role === "child"), [rows]);

  const addRow = (role: FamilyRole) => {
    const palette = COLOR_PALETTE[rows.length % COLOR_PALETTE.length];
    setRows((prev) => [...prev, { id: newId(), name: "", role, color: palette.color }]);
  };

  const updateRow = (id: string, patch: Partial<DraftRow>) => {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  const removeRow = (id: string) => {
    setRows((prev) => prev.filter((row) => row.id !== id));
  };

  const handleSave = async () => {
    const members = rows
      .map((row) => ({
        name: row.name.trim(),
        role: row.role,
        color: row.color,
        key: row.key,
      }))
      .filter((row) => row.name && !/^הורה\s*\d+$/.test(row.name) && !/^ילד\s*\d+$/.test(row.name));
    const hasParent = members.some((row) => row.role === "parent");
    const hasChild = members.some((row) => row.role === "child");
    if (!members.length) {
      setError("יש להזין לפחות שם אחד.");
      return;
    }
    if (requireParentAndChild && (!hasParent || !hasChild)) {
      setError("יש להזין לפחות הורה אחד וילד אחד.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onSave(members);
    } catch (err) {
      setError(err instanceof Error ? err.message : "שמירת בני המשפחה נכשלה");
    } finally {
      setBusy(false);
    }
  };

  const renderGroup = (role: FamilyRole, label: string, items: DraftRow[]) => (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-bold text-slate-700">{label}</div>
        <button
          type="button"
          onClick={() => addRow(role)}
          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
        >
          <Plus size={14} /> הוספה
        </button>
      </div>
      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 px-3 py-2 text-xs text-slate-500">
          אין עדיין שמות בקבוצה הזו.
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((row) => (
            <div key={row.id} className="rounded-xl border border-slate-200 bg-slate-50 p-2.5 space-y-2">
              <div className="flex items-center gap-2">
                <input
                  value={row.name}
                  onChange={(event) => updateRow(row.id, { name: event.target.value })}
                  placeholder={role === "parent" ? ONBOARDING_PLACEHOLDERS.parent : ONBOARDING_PLACEHOLDERS.child}
                  className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-blue-400"
                />
                <button
                  type="button"
                  onClick={() => removeRow(row.id)}
                  className="h-8 w-8 rounded-lg text-rose-600 hover:bg-rose-50 flex items-center justify-center"
                  aria-label="מחיקה"
                >
                  <Trash2 size={15} />
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {COLOR_PALETTE.map((swatch) => {
                  const selected = row.color === swatch.color;
                  return (
                    <button
                      key={`${row.id}-${swatch.color}`}
                      type="button"
                      onClick={() => updateRow(row.id, { color: swatch.color })}
                      className={`h-6 w-6 rounded-full ${swatch.color} ${selected ? "ring-2 ring-offset-1 ring-slate-700" : ""}`}
                      aria-label={swatch.color}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="fixed inset-0 z-[70] bg-black/40 backdrop-blur-[1px] flex items-start sm:items-center justify-center p-3 pt-8 print:hidden">
      <div className="w-full max-w-lg max-h-[90dvh] overflow-y-auto bg-white rounded-2xl shadow-2xl border border-slate-200 p-4 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-bold text-slate-800">{title}</h3>
            {subtitle ? <p className="mt-1 text-sm text-slate-500 leading-relaxed">{subtitle}</p> : null}
          </div>
          {allowClose && onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="h-8 w-8 rounded-full bg-slate-100 text-slate-700 hover:bg-slate-200 flex items-center justify-center"
              aria-label="סגור"
            >
              <X size={18} />
            </button>
          ) : null}
        </div>

        {renderGroup("parent", "הורים", parents)}
        {renderGroup("child", "ילדים", children)}

        {error ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div>
        ) : null}

        <div className="flex flex-col sm:flex-row gap-2">
          <button
            type="button"
            onClick={() => { void handleSave(); }}
            disabled={busy}
            className="flex-1 rounded-xl bg-slate-800 px-3 py-2.5 text-sm font-bold text-white hover:bg-slate-700 disabled:opacity-60"
          >
            {busy ? "שומר..." : saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
