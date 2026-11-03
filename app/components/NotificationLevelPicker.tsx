"use client";

import { Volume2, VolumeX } from "lucide-react";
import { NOTIFICATION_LEVEL_OPTIONS, type NotificationLevel } from "@/app/lib/notificationCategory";
import { playNotificationLevel } from "@/app/lib/notificationSound";

type NotificationLevelPickerProps = {
  value: NotificationLevel;
  onChange: (level: NotificationLevel) => void;
  disabled?: boolean;
  name?: string;
};

export default function NotificationLevelPicker({
  value,
  onChange,
  disabled = false,
  name = "notification-level",
}: NotificationLevelPickerProps) {
  return (
    <div className="space-y-1.5" role="radiogroup" aria-label="רמת התראה">
      {NOTIFICATION_LEVEL_OPTIONS.map((option) => {
        const selected = value === option.value;
        const silent = option.value === "silent";
        return (
          <div key={`${name}-${option.value}`} className="flex items-center gap-2">
            <button
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange(option.value)}
              className={`flex-1 rounded-xl border px-3 py-1.5 text-sm font-semibold text-right transition disabled:opacity-60 disabled:cursor-not-allowed ${
                selected
                  ? "bg-blue-50 border-blue-400 text-blue-700"
                  : "bg-white border-slate-300 text-slate-700 hover:bg-slate-50"
              }`}
            >
              {option.label}
            </button>
            <button
              type="button"
              aria-label={silent ? "שקטה — בלי צליל" : `השמע ${option.label}`}
              disabled={silent}
              onClick={() => { void playNotificationLevel(option.value); }}
              className="shrink-0 inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {silent ? <VolumeX size={16} aria-hidden="true" /> : <Volume2 size={16} aria-hidden="true" />}
            </button>
          </div>
        );
      })}
    </div>
  );
}
