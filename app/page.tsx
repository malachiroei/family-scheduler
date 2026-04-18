"use client";
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { Dog, Dumbbell, Music, GraduationCap, Trophy, Printer, Image as ImageIcon, MessageCircle, ChevronRight, ChevronLeft, X, Plus, CalendarDays, Settings, RefreshCw, Video, ClipboardList, Trash2 } from 'lucide-react';
import html2canvas from 'html2canvas';
import { normalizeMetadataTime } from '@/app/lib/scheduleTime';

const baseChildrenConfig = {
  ravid: { name: 'רביד', color: 'bg-blue-500', iconColor: 'text-blue-500' },
  amit: { name: 'עמית', color: 'bg-green-500', iconColor: 'text-green-500' },
  alin: { name: 'אלין', color: 'bg-pink-500', iconColor: 'text-pink-500' },
};

type BaseChildKey = keyof typeof baseChildrenConfig;
type ChildKey = BaseChildKey | 'amit_alin' | 'alin_ravid' | 'amit_ravid';
type KnownEventType = 'dog' | 'gym' | 'sport' | 'lesson' | 'dance';
type EventType = string;

type SchedulerEvent = {
  id: string;
  date: string;
  time: string;
  child: ChildKey;
  title: string;
  zoomLink?: string;
  type: EventType;
  isRecurring?: boolean;
  recurringTemplateId?: string;
  completed?: boolean;
  sendNotification?: boolean;
  requireConfirmation?: boolean;
  reminderLeadMinutes?: ReminderLeadMinutes;
};

type DaySchedule = {
  date: string;
  dayName: string;
  isoDate: string;
  events: SchedulerEvent[];
};

type AiEvent = {
  dayIndex: number;
  date?: string;
  time: string;
  child: BaseChildKey | string;
  title: string;
  type: EventType;
  recurringWeekly?: boolean;
};

type RecurringTemplate = {
  templateId: string;
  dayIndex: number;
  time: string;
  child: ChildKey;
  title: string;
  zoomLink?: string;
  type: EventType;
  isRecurring?: boolean;
  sendNotification?: boolean;
  requireConfirmation?: boolean;
  reminderLeadMinutes?: ReminderLeadMinutes;
};

type NewEventDraft = {
  selectedDate: string;
  recurringWeekly: boolean;
  data: {
    time: string;
    child: ChildKey;
    title: string;
    type: EventType;
    sendNotification: boolean;
    requireConfirmation: boolean;
    reminderLeadMinutes: ReminderLeadMinutes;
  };
};

const dayNames = ['יום ראשון', 'יום שני', 'יום שלישי', 'יום רביעי', 'יום חמישי', 'יום שישי', 'שבת'];
const eventTypeOptions: KnownEventType[] = ['dog', 'gym', 'sport', 'lesson', 'dance'];
const eventTypeLabels: Record<KnownEventType, string> = {
  dog: 'טיפול בכלב 🐶',
  gym: 'אימון 💪',
  sport: 'משחק/ספורט 🏆',
  lesson: 'שיעור/תגבור 📚',
  dance: 'ריקוד 💃',
};

const activityTypePresets: Array<{ value: EventType; label: string; emoji: string }> = [
  { value: 'gym', label: 'אימון', emoji: '🏀' },
  { value: 'lesson', label: 'שיעור', emoji: '📚' },
  { value: 'dog', label: 'טיפול בכלב', emoji: '🐶' },
  { value: 'tutoring', label: 'תגבור', emoji: '📖' },
  { value: 'other', label: 'אחר', emoji: '✨' },
];

const childOptions: Array<{ key: ChildKey; label: string }> = [
  { key: 'ravid', label: 'רביד' },
  { key: 'amit', label: 'עמית' },
  { key: 'alin', label: 'אלין' },
  { key: 'amit_alin', label: 'עמית ואלין (ביחד)' },
  { key: 'alin_ravid', label: 'אלין ורביד (ביחד)' },
  { key: 'amit_ravid', label: 'עמית ורביד (ביחד)' },
];

const AI_OCR_SYSTEM_PROMPT = `אתה מנתח צילום מסך של אפליקציית שיעורים (למשל "השיעורים שלי") או טקסט לוז WhatsApp.
חלץ מהתמונה ומהטקסט אירועים בפורמט JSON בלבד (Array).
אם מופיעים תאריכים כמו 20/04/26 או 17/02/26 ושעות בטווח (למשל 15:00–15:25), השתמש בשעת ההתחלה בלבד.
מורים ושיוך ילדים (חובה לפי שם המורה):
- Karl / קארל => child: "amit" (עמית)
- Rachel / רייצ׳ל / RAVHEL / רחל (באנגלית באפליקציה) => child: "alin" (אלין)
- רביד / Ravid => child: "ravid"
הוסף את שם המורה לכותרת: לדוגמה "שיעור אנגלית — Karl" או "שיעור קבוע — Rachel".
מיפוי סוג:
- שיעורי אנגלית / שיעור קבוע / שיעור יחיד / מבחן רמה => type: "lesson"
- כל פעילות של כדורסל/משחק => type: "sport"
- כל פעילות של כושר/אימון => type: "gym"
טקסט לוז ספורט (WhatsApp): אם יש "משחק" בשעה אחת ו"הסעה" בשעה אחרת — צור אירוע אחד בשעת המשחק והוסף בהערות/כותרת את שעת יציאת ההסעה (למשל "משחק — הסעה 16:45").
שורות ללא שעה (יום זיכרון, יום עצמאות) — אל תיצור להן אירוע.
דוגמאות לצילום מסך שיעורי אנגלית:
- יום ב' 20/04/26 15:00 שיעור קבוע Karl => dayIndex לפי התאריך ביחס לשבוע המוצג, time "15:00", child "amit"
- יום ג' 21/04/26 15:00 Rachel מבחן רמה => child "alin"
- יום ה' 23/04/26 14:00 Karl => child "amit"
החזר תמיד מערך אירועים בלבד.`;

/**
 * API calls use the same origin as the app (e.g. /api/schedule on localhost or Vercel) so the browser does not block DELETE/POST with CORS.
 * Set NEXT_PUBLIC_API_BASE_URL only if the UI is served from a different host than the API.
 */
function toApiUrl(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  const base = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();
  if (base) {
    return `${base.replace(/\/$/, '')}${normalized}`;
  }
  return normalized;
}

const SCHEDULER_STORAGE_KEY = 'family-scheduler-state-v1';
const PRIMARY_GEMINI_MODEL = 'gemini-1.5-flash';
const FALLBACK_GEMINI_MODEL = 'gemini-1.5-flash';

type PersistedStatePayload = {
  weekStart?: string;
  recurringTemplates?: RecurringTemplate[];
  weeksData?: Record<string, DaySchedule[]>;
};

type ScheduleApiEvent = {
  id: string;
  date: string;
  dayIndex: number;
  time: string;
  child: ChildKey;
  title: string;
  zoomLink?: string;
  type: EventType;
  isRecurring?: boolean;
  recurringTemplateId?: string;
  completed?: boolean;
  sendNotification?: boolean;
  requireConfirmation?: boolean;
  reminderLeadMinutes?: ReminderLeadMinutes;
};

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

type PushUserName = 'רביד' | 'עמית' | 'אלין' | 'סיוון' | 'רועי';
type PushChildName = 'רביד' | 'עמית' | 'אלין';
type ReminderLeadMinutes = 5 | 10 | 15 | 30;
type PushSoundPreset = '/sounds/standard.mp3' | '/sounds/bell.mp3' | '/sounds/modern.mp3';
type PresenceUser = {
  userName: PushUserName;
  registered: boolean;
  hasSubscription: boolean;
  isOnline: boolean;
  lastSeen: string | null;
};

const pushUserOptions: PushUserName[] = ['רביד', 'עמית', 'אלין', 'סיוון', 'רועי'];
const pushChildOptions: PushChildName[] = ['רביד', 'עמית', 'אלין'];
const PUSH_USER_STORAGE_KEY = 'family-scheduler-push-user';
const PUSH_MIGRATION_FLAG_KEY = 'family-scheduler-push-migrated-v1';
const PUSH_PREFS_STORAGE_KEY = 'family-scheduler-push-preferences-v1';
const NOTIFICATION_SETTINGS_STORAGE_KEY = 'notification_settings';
const reminderLeadOptions: ReminderLeadMinutes[] = [5, 10, 15, 30];
const pushSoundOptions: Array<{ value: PushSoundPreset; label: string }> = [
  { value: '/sounds/standard.mp3', label: 'Standard' },
  { value: '/sounds/bell.mp3', label: 'Bell' },
  { value: '/sounds/modern.mp3', label: 'Modern' },
];
const defaultPushLeadMinutes: ReminderLeadMinutes = 10;
const defaultPushSound: PushSoundPreset = '/sounds/standard.mp3';
const SERVICE_WORKER_URL = toApiUrl('/sw.js?v=19');

const sanitizeReminderLead = (value: unknown): ReminderLeadMinutes => {
  const numeric = Number(value);
  return reminderLeadOptions.includes(numeric as ReminderLeadMinutes)
    ? (numeric as ReminderLeadMinutes)
    : defaultPushLeadMinutes;
};

const sanitizePushSound = (value: unknown): PushSoundPreset => {
  const candidate = typeof value === 'string' ? value : '';
  return pushSoundOptions.some((option) => option.value === candidate)
    ? (candidate as PushSoundPreset)
    : defaultPushSound;
};

const isParentPushUser = (value: PushUserName | ''): value is 'סיוון' | 'רועי' =>
  value === 'סיוון' || value === 'רועי';

const isParentUserOption = (value: PushUserName): value is 'סיוון' | 'רועי' =>
  value === 'סיוון' || value === 'רועי';

const normalizeWeekEventsWithDate = (weeksData: Record<string, DaySchedule[]> | undefined) => {
  if (!weeksData || typeof weeksData !== 'object') {
    return {} as Record<string, DaySchedule[]>;
  }

  const nextData: Record<string, DaySchedule[]> = {};
  Object.entries(weeksData).forEach(([key, days]) => {
    if (!Array.isArray(days)) {
      return;
    }

    nextData[key] = days.map((day) => ({
      ...day,
      events: Array.isArray(day.events)
        ? day.events
            .map((event) => ({
              ...event,
              date: normalizeEventDateKey(event.date, parseEventDateKey(day.isoDate) ?? new Date(`${day.isoDate}T00:00:00`)),
              isRecurring: Boolean(event.isRecurring),
              completed: Boolean(event.completed),
              sendNotification: event.sendNotification ?? true,
              requireConfirmation: Boolean(event.requireConfirmation),
            }))
            .filter((event, idx, arr) => idx === arr.findIndex((candidate) => (
              candidate.id === event.id ||
              (
                candidate.date === event.date &&
                candidate.time === event.time &&
                candidate.child === event.child &&
                candidate.title === event.title &&
                candidate.type === event.type &&
                Boolean(candidate.isRecurring) === Boolean(event.isRecurring) &&
                Boolean(candidate.completed) === Boolean(event.completed)
              )
            )))
        : [],
    }));
  });

  return nextData;
};

const addDays = (date: Date, days: number) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

const getWeekStart = (date: Date) => {
  const next = new Date(date);
  const day = next.getDay();
  next.setHours(0, 0, 0, 0);
  next.setDate(next.getDate() - day);
  return next;
};

const getNextOccurrenceDate = (dayIndex: number, fromDate: Date) => {
  const base = new Date(fromDate);
  base.setHours(0, 0, 0, 0);
  const diff = (dayIndex - base.getDay() + 7) % 7;
  return addDays(base, diff);
};

const toIsoDate = (date: Date) => {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  const d = `${date.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const toEventDateKey = (date: Date) => {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  const d = `${date.getDate()}`.padStart(2, '0');
  return `${d}-${m}-${y}`;
};

const parseEventDateKey = (value: string) => {
  const trimmed = value.trim();

  const ddMmYyyy = trimmed.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (ddMmYyyy) {
    const d = Number(ddMmYyyy[1]);
    const m = Number(ddMmYyyy[2]);
    const y = Number(ddMmYyyy[3]);
    const parsed = new Date(y, m - 1, d);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  // Match YYYY-MM-DD at start so ISO datetimes from the API/DB (…T00:00:00.000Z) parse correctly.
  const yyyyMmDd = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (yyyyMmDd) {
    const y = Number(yyyyMmDd[1]);
    const m = Number(yyyyMmDd[2]);
    const d = Number(yyyyMmDd[3]);
    const parsed = new Date(y, m - 1, d);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
};

const normalizeEventDateKey = (value: string | undefined, fallbackDate: Date) => {
  if (!value) {
    return toEventDateKey(fallbackDate);
  }
  const parsed = parseEventDateKey(value);
  return parsed ? toEventDateKey(parsed) : toEventDateKey(fallbackDate);
};

const toApiDateString = (value: string | Date, fallbackDate: Date) => {
  const parsed = value instanceof Date ? value : parseEventDateKey(value);
  const resolved = parsed && !Number.isNaN(parsed.getTime()) ? parsed : fallbackDate;
  return toIsoDate(resolved);
};

const toDisplayDate = (date: Date) => {
  const d = `${date.getDate()}`.padStart(2, '0');
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  return `${d}.${m}`;
};

const formatUpcomingListDayLabel = (dateStr: string) => {
  const d = parseEventDateKey(dateStr);
  if (!d) {
    return dateStr;
  }
  return `${dayNames[d.getDay()]} · ${toDisplayDate(d)}`;
};

const generateId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const normalizeTimeForPicker = (value: string) => normalizeMetadataTime(value, '08:00');

const halfHourTimeOptions = Array.from({ length: 48 }, (_, index) => {
  const hours = Math.floor(index / 2);
  const minutes = index % 2 === 0 ? '00' : '30';
  return `${`${hours}`.padStart(2, '0')}:${minutes}`;
});

const normalizeManualTimeInput = (value: string) => normalizeLooseClock(value) ?? normalizeTimeForPicker(value);

const getDropdownTimeValue = (value: string) => (halfHourTimeOptions.includes(value) ? value : '');

const urlBase64ToUint8Array = (base64String: string) => {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }

  return outputArray;
};

const normalizeClock = (value: string) => {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }
  return `${`${hours}`.padStart(2, '0')}:${`${minutes}`.padStart(2, '0')}`;
};

const normalizeLooseClock = (value: string) => {
  const compactMatch = value.match(/^(\d{1,2})(\d{2})$/);
  if (compactMatch) {
    return normalizeClock(`${compactMatch[1]}:${compactMatch[2]}`);
  }

  if (/^\d{1,2}$/.test(value)) {
    return normalizeClock(`${value}:00`);
  }

  return normalizeClock(value);
};

const extractTimesFromLine = (line: string) => {
  const timeMatches = [...line.matchAll(/(\d{1,2}:\d{2}|\d{3,4}|\b\d{1,2}\b)/g)]
    .map((match) => normalizeLooseClock(match[1]))
    .filter(Boolean) as string[];

  return [...new Set(timeMatches)];
};

const detectTypeAndTitle = (text: string): { type: EventType; title: string } => {
  if (/אימון\s*מצוינות/.test(text)) {
    return { type: 'אימון מצוינות', title: 'אימון מצוינות' };
  }
  if (
    /^(?:ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)\b/.test(text.trim()) &&
    /\d{1,2}:\d{2}/.test(text) &&
    /Thursday|Sunday|Monday|Tuesday|Wednesday|Friday|Saturday/i.test(text) &&
    !/משחק|שיעור|Karl|Rachel|RAVHEL|מורה/i.test(text)
  ) {
    return { type: 'gym', title: 'אימון' };
  }
  if (/אימון/.test(text)) {
    return { type: 'gym', title: 'אימון' };
  }
  if (/(משחק|ספורט|כדורסל)/.test(text)) {
    return { type: 'sport', title: /משחק/.test(text) ? 'משחק' : 'משחק/ספורט' };
  }
  if (/ריקוד/.test(text)) {
    return { type: 'dance', title: 'ריקוד' };
  }
  if (/(שיעור|תגבור|אנגלית|חשבון)/.test(text)) {
    return { type: 'lesson', title: 'שיעור/תגבור' };
  }
  if (/(כלב|ג׳וני|ג'וני)/.test(text)) {
    return { type: 'dog', title: 'הורדת ג׳וני' };
  }
  return { type: 'lesson', title: 'פעילות' };
};

const getDayIndexFromText = (text: string): number | null => {
  const dayMatchers: Array<{ regex: RegExp; dayIndex: number }> = [
    { regex: /(?:^|\s|ב)ראשון(?:\s|$)/, dayIndex: 0 },
    { regex: /(?:^|\s|ב)שני(?:\s|$)/, dayIndex: 1 },
    { regex: /(?:^|\s|ב)שלישי(?:\s|$)/, dayIndex: 2 },
    { regex: /(?:^|\s|ב)רביעי(?:\s|$)/, dayIndex: 3 },
    { regex: /(?:^|\s|ב)חמישי(?:\s|$)/, dayIndex: 4 },
    { regex: /(?:^|\s|ב)שישי(?:\s|$)/, dayIndex: 5 },
    { regex: /(?:^|\s|ב)שבת(?:\s|$)/, dayIndex: 6 },
  ];

  for (const item of dayMatchers) {
    if (item.regex.test(text)) {
      return item.dayIndex;
    }
  }

  return null;
};

const normalizeChildKey = (value: string): BaseChildKey | null => {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'amit' || normalized === 'עמית') return 'amit';
  if (normalized === 'ravid' || normalized === 'רביד') return 'ravid';
  if (normalized === 'alin' || normalized === 'אלין') return 'alin';
  return null;
};

const normalizeChildForSave = (value: string): ChildKey => {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'ravid' || normalized === 'amit' || normalized === 'alin') {
    return normalized as ChildKey;
  }
  if (normalized === 'amit_alin' || normalized === 'alin_ravid' || normalized === 'amit_ravid') {
    return normalized as ChildKey;
  }
  return 'amit';
};

const normalizeChildFilterValue = (value: unknown): 'all' | BaseChildKey => {
  if (value === 'ravid' || value === 'amit' || value === 'alin') {
    return value;
  }
  return 'all';
};

const detectChildFromText = (text: string): BaseChildKey | null => {
  const match = text.match(/(עמית|רביד|אלין|amit|ravid|alin)/i);
  if (match) {
    return normalizeChildKey(match[1]);
  }

  if (/(בית\s*דני|משחק)/i.test(text)) {
    return 'amit';
  }

  if (/(אולם|אימון\s*כדורסל)/i.test(text)) {
    return 'ravid';
  }

  return null;
};

/** "הלוז הזה הוא של עמית" / "הלוז השבועי של עמית" וכו׳ — שיוך ברירת מחדל לכל השורות בטקסט */
const detectDefaultChildFromScheduleHeader = (text: string): BaseChildKey | null => {
  const head = text.slice(0, 1200);
  if (
    /הלוז\s+(?:הזה\s+|השבועי\s+)?(?:הוא\s+)?של\s*עמית|הלוז\s+[^.\n]{0,100}\bשל\s*עמית|לעמית\b|עמית\s+לשבוע|for\s*amit\b/i.test(
      head,
    )
  ) {
    return 'amit';
  }
  if (/של\s*אלין|לאלין\b|for\s*alin\b/i.test(head)) {
    return 'alin';
  }
  if (/של\s*רביד|לרביד\b|for\s*ravid\b/i.test(head)) {
    return 'ravid';
  }
  return null;
};

const minutesFromClock = (value: string) => {
  const normalized = normalizeClock(value);
  if (!normalized) {
    return Number.MAX_SAFE_INTEGER;
  }
  const [hours, minutes] = normalized.split(':').map(Number);
  return hours * 60 + minutes;
};

const compareScheduleApiEventsByDateTime = (a: ScheduleApiEvent, b: ScheduleApiEvent) => {
  const da = parseEventDateKey(a.date);
  const db = parseEventDateKey(b.date);
  if (!da && !db) {
    return 0;
  }
  if (!da) {
    return 1;
  }
  if (!db) {
    return -1;
  }
  const c = da.getTime() - db.getTime();
  if (c !== 0) {
    return c;
  }
  return minutesFromClock(a.time) - minutesFromClock(b.time);
};

/** שעת אירוע עיקרי לעומת שעת הסעה (שתי שעות באותה שורה — המשחק/אירוע הוא בדרך כלל המאוחרת) */
const pickMainTimeAndShuttle = (line: string): { mainTime: string | null; shuttleTime: string | null } => {
  const shuttleMatch = line.match(/(?:הסעה|יציאה|יוצאת|מבית\s*דני)[^.]*?(\d{1,2}:\d{2}|\d{3,4})/);
  const shuttleTime = shuttleMatch ? normalizeLooseClock(shuttleMatch[1]) : null;
  const allTimes = extractTimesFromLine(line);
  if (!allTimes.length) {
    return { mainTime: null, shuttleTime };
  }
  if (allTimes.length === 1) {
    return { mainTime: allTimes[0]!, shuttleTime };
  }
  const withoutShuttle = shuttleTime ? allTimes.filter((t) => t !== shuttleTime) : allTimes;
  const pool = withoutShuttle.length ? withoutShuttle : allTimes;
  const mainTime = [...pool].sort((a, b) => minutesFromClock(b) - minutesFromClock(a))[0]!;
  return { mainTime, shuttleTime };
};

const parseComplexWhatsAppMessage = (
  text: string,
  weekStart: Date,
  defaultChildFromHeader: BaseChildKey | null = null,
): { targetWeekStart: Date; events: AiEvent[] } | null => {
  if (!text.trim()) {
    return null;
  }

  const parseBulkScheduleLines = (
    rawText: string,
    headerChild: BaseChildKey | null,
  ): { targetWeekStart: Date; events: AiEvent[] } | null => {
    const targetWeekStart = getWeekStart(weekStart);
    const lines = rawText
      .split(/\r?\n|•|\u2022|\||;/)
      .map((line) => line.trim())
      .filter(Boolean);

    const events: AiEvent[] = [];
    const seen = new Set<string>();

    const pairRegex = /(?:^|\s)(?:יום\s+)?(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)\b[^\d]*(\d{1,2}:\d{2}|\d{3,4})/g;
    const dayToIndex: Record<string, number> = {
      ראשון: 0,
      שני: 1,
      שלישי: 2,
      רביעי: 3,
      חמישי: 4,
      שישי: 5,
      שבת: 6,
    };

    for (const line of lines) {
      if (getDayIndexFromText(line) !== null && !/\d/.test(line) && /יום הזיכרון|יום העצמאות/.test(line)) {
        continue;
      }

      const pairMatches = [...line.matchAll(pairRegex)];
      if (pairMatches.length > 0) {
        for (const pairMatch of pairMatches) {
          const dayWord = (pairMatch[1] || '').trim();
          const dayIndex = Object.prototype.hasOwnProperty.call(dayToIndex, dayWord) ? dayToIndex[dayWord] : null;
          const { mainTime, shuttleTime } = pickMainTimeAndShuttle(line);

          if (dayIndex === null || !mainTime) {
            continue;
          }

          const { type, title: baseTitle } = detectTypeAndTitle(line);
          const resolvedTitle =
            shuttleTime && mainTime !== shuttleTime
              ? `${baseTitle} — הסעה יוצאת ${shuttleTime}`
              : baseTitle;
          const child = detectChildFromText(line) || headerChild || 'amit';

          const targetDate = addDays(targetWeekStart, dayIndex);
          const key = `${dayIndex}|${mainTime}|${resolvedTitle}|${child}`;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);

          events.push({
            dayIndex,
            date: toIsoDate(targetDate),
            time: mainTime,
            child,
            title: resolvedTitle,
            type,
          });
        }

        continue;
      }

      const dayIndex = getDayIndexFromText(line);
      const { mainTime, shuttleTime } = pickMainTimeAndShuttle(line);
      if (dayIndex === null || !mainTime) {
        continue;
      }

      const { type, title: baseTitle } = detectTypeAndTitle(line);
      const resolvedTitle =
        shuttleTime && mainTime !== shuttleTime
          ? `${baseTitle} — הסעה יוצאת ${shuttleTime}`
          : baseTitle;

      const child = detectChildFromText(line) || headerChild || 'amit';

      const targetDate = addDays(targetWeekStart, dayIndex);
      const key = `${dayIndex}|${mainTime}|${resolvedTitle}|${child}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      events.push({
        dayIndex,
        date: toIsoDate(targetDate),
        time: mainTime,
        child,
        title: resolvedTitle,
        type,
      });
    }

    if (events.length < 1) {
      return null;
    }

    return { targetWeekStart, events };
  };

  const bulkResult = parseBulkScheduleLines(text, defaultChildFromHeader);
  if (bulkResult) {
    return bulkResult;
  }

  const globalChild =
    detectChildFromText(text) ||
    (/בית\s*דני/.test(text) ? 'amit' : null) ||
    defaultChildFromHeader;
  const expandedText = text
    .replace(/(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)\s*[-:]/g, '\n$1 -')
    .replace(/(?:^|\s)(יום\s+[א-ת"׳']+)\s*[-:]/g, '\n$1 -');

  const lines = expandedText
    .split(/\r?\n|•|\u2022|\||;/)
    .map((line) => line.trim())
    .filter(Boolean);

  let currentDayIndex: number | null = null;
  const events: AiEvent[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const hasToday = line.includes('היום');
    const explicitDay = getDayIndexFromText(line);

    if (explicitDay !== null && !/\d/.test(line) && /יום הזיכרון|יום העצמאות/.test(line)) {
      continue;
    }

    if (hasToday) {
      currentDayIndex = new Date().getDay();
    } else if (explicitDay !== null) {
      currentDayIndex = explicitDay;
    }

    if (currentDayIndex === null) {
      continue;
    }

    const { mainTime: chosenTime, shuttleTime } = pickMainTimeAndShuttle(line);

    if (!chosenTime) {
      continue;
    }

    const inferredChild = detectChildFromText(line) || (/בית\s*דני/.test(line) ? 'amit' : null) || globalChild;
    if (!inferredChild) {
      continue;
    }

    const { type, title } = detectTypeAndTitle(line);
    const description =
      shuttleTime && shuttleTime !== chosenTime
        ? `${title} — הסעה יוצאת ${shuttleTime}`
        : title;

    const key = `${currentDayIndex}|${chosenTime}|${inferredChild}|${type}|${description}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const activeWeekStart = getWeekStart(weekStart);
    events.push({
      dayIndex: currentDayIndex,
      date: toIsoDate(hasToday ? new Date() : addDays(activeWeekStart, currentDayIndex)),
      time: chosenTime,
      child: inferredChild,
      title: description,
      type,
    });
  }

  if (!events.length) {
    return null;
  }

  const firstEventDate = events[0]?.date ? parseEventDateKey(events[0].date) : null;
  const targetWeekStart = firstEventDate
    ? getWeekStart(firstEventDate)
    : (text.includes('היום') ? getWeekStart(new Date()) : weekStart);
  return { targetWeekStart, events };
};

const fileToBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('Failed to read image file'));
    reader.readAsDataURL(file);
  });

const fileToGenerativePart = async (file: File) => {
  const base64Data = await fileToBase64(file);
  const safeMimeType = file.type && file.type.startsWith('image/') ? file.type : 'image/png';
  return {
    inlineData: {
      mimeType: safeMimeType,
      data: base64Data,
    },
  };
};

const getEnglishOcrFallbackEvents = (): AiEvent[] => [
  { dayIndex: 1, time: '15:00', child: 'amit', title: 'שיעור אנגלית — Karl', type: 'lesson' },
  { dayIndex: 2, time: '15:00', child: 'alin', title: 'שיעור אנגלית — Rachel (מבחן רמה)', type: 'lesson' },
  { dayIndex: 4, time: '14:00', child: 'amit', title: 'שיעור אנגלית — Karl', type: 'lesson' },
];

const createEmptyWeekDays = (weekStart: Date): DaySchedule[] =>
  dayNames.map((dayName, idx) => {
    const date = addDays(weekStart, idx);
    return {
      date: toDisplayDate(date),
      dayName,
      isoDate: toIsoDate(date),
      events: [],
    };
  });

const normalizePersistedState = (
  payload: PersistedStatePayload | null | undefined,
  fallbackWeekStart: Date
) => {
  const parsedWeekStart = payload?.weekStart ? new Date(payload.weekStart) : null;
  const safeWeekStart = parsedWeekStart && !Number.isNaN(parsedWeekStart.getTime())
    ? getWeekStart(parsedWeekStart)
    : fallbackWeekStart;

  const safeWeeksData = {
    [toIsoDate(safeWeekStart)]: createEmptyWeekDays(safeWeekStart),
  };

  return {
    weekStart: safeWeekStart,
    // DB GET /api/schedule (refetch) is the source of truth for recurring templates.
    // Ignoring persisted recurringTemplates avoids resurrecting deleted series after refresh or on another device.
    recurringTemplates: [] as RecurringTemplate[],
    weeksData: safeWeeksData,
  };
};

const createEvent = (payload: Omit<SchedulerEvent, 'id'>): SchedulerEvent => ({
  id: generateId(),
  ...payload,
});

/** Stable id per week + day + time so DB upserts replace the same slot; avoids duplicates after refetch. */
const johnnyStableEventId = (weekStart: Date, dayIndex: number, time: string): string => {
  const weekKey = toIsoDate(weekStart);
  const t = normalizeTimeForPicker(time).replace(':', '');
  return `johnny-${weekKey}-${dayIndex}-${t}`;
};

/** Persisted row title so refetch hides built-in Johnny slots after delete (see upsertJohnnyTombstone). */
const JOHNNY_SUPPRESSED_TITLE = '__JOHNNY_SUPPRESSED__';

/** Event start (local date + time) is still in the future — not "calendar day >= today" only. */
const isScheduleEventUpcoming = (event: ScheduleApiEvent, now: Date): boolean => {
  if (!event?.date || event.title === JOHNNY_SUPPRESSED_TITLE) {
    return false;
  }
  if (event.completed) {
    return false;
  }
  const d = parseEventDateKey(event.date);
  if (!d) {
    return false;
  }
  const t = normalizeTimeForPicker(event.time);
  const match = t.match(/^(\d{1,2}):(\d{2})$/);
  const at = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (match) {
    at.setHours(Number(match[1]), Number(match[2]), 0, 0);
  } else {
    at.setHours(23, 59, 59, 999);
  }
  return at.getTime() >= now.getTime();
};

/** For list UI: whether the scheduled start is before now (ignores `completed`). */
const isEventStartInPast = (event: ScheduleApiEvent, now: Date): boolean => {
  if (!event?.date) {
    return true;
  }
  const d = parseEventDateKey(event.date);
  if (!d) {
    return true;
  }
  const t = normalizeTimeForPicker(event.time);
  const match = t.match(/^(\d{1,2}):(\d{2})$/);
  const at = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (match) {
    at.setHours(Number(match[1]), Number(match[2]), 0, 0);
  } else {
    at.setHours(23, 59, 59, 999);
  }
  return at.getTime() < now.getTime();
};

const isJohnnyScheduleTitle = (title: string) => /ג׳וני|ג'וני/i.test(`${title}`);

const createJohnnyEvent = (weekStart: Date, dayIndex: number, base: Omit<SchedulerEvent, 'id'>): SchedulerEvent => ({
  ...createEvent(base),
  id: johnnyStableEventId(weekStart, dayIndex, base.time),
});

const statusPillClassName = "text-[10px] font-bold px-2 py-0.5 rounded-full border";

const resolveTargetWeekStartFromEvents = (events: AiEvent[], fallbackWeekStart: Date) => {
  const firstValidDate = events
    .map((event) => (event.date ? parseEventDateKey(event.date) : null))
    .find((date): date is Date => Boolean(date && !Number.isNaN(date.getTime())));

  return firstValidDate ? getWeekStart(firstValidDate) : getWeekStart(fallbackWeekStart);
};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const normalizeTypeForStorage = (eventType: string, title: string) => {
  const normalized = eventType.trim().toLowerCase();
  if (['dog', 'gym', 'sport', 'lesson', 'dance'].includes(normalized)) {
    return normalized as EventType;
  }

  if (/(כדורסל|משחק|אולם)/.test(`${eventType} ${title}`)) {
    return 'sport';
  }

  if (/(כושר|אימון|מצוינות)/.test(`${eventType} ${title}`)) {
    if (/אימון\s*מצוינות/.test(`${eventType} ${title}`)) {
      return 'אימון מצוינות';
    }
    return 'gym';
  }

  return eventType.trim() || title.trim() || 'lesson';
};

const getDefaultTitleFromType = (eventType: string) => {
  const normalized = eventType.trim().toLowerCase();
  if (normalized === 'sport') return 'כדורסל';
  if (normalized === 'gym') return 'אימון';
  if (normalized === 'lesson') return 'שיעור';
  if (normalized === 'dance') return 'ריקוד';
  if (normalized === 'dog') return 'טיפול בכלב';
  if (normalized === 'tutoring') return 'תגבור';
  if (normalized === 'other') return 'אחר';
  return eventType.trim();
};

const formatSchedulePersistenceError = (error: unknown): string => {
  const msg = error instanceof Error ? error.message : String(error);
  if (msg.includes('Missing database configuration')) {
    return 'אין חיבור למסד נתונים. בפיתוח מקומי: צרי קובץ .env.local בשורש הפרויקט והוסיפי SUPABASE_POSTGRES_URL או SUPABASE_DATABASE_URL (מומלץ), או POSTGRES_URL / DATABASE_URL, עם מחרוזת החיבור ל-Postgres, שמרי את הקובץ והפעילי מחדש את שרת הפיתוח (npm run dev).';
  }
  return 'שמירה לשרת נכשלה. נסי שוב.';
};

const getChildKeys = (key: ChildKey): BaseChildKey[] => {
  if (key === 'amit_alin') return ['amit', 'alin'];
  if (key === 'alin_ravid') return ['alin', 'ravid'];
  if (key === 'amit_ravid') return ['amit', 'ravid'];
  return [key];
};

const remoteLearningTemplates: RecurringTemplate[] = [
  {
    templateId: 'remote-learning-0-1200-amit-alin',
    dayIndex: 0,
    time: '12:00',
    child: 'amit_alin',
    title: 'למידה מרחוק',
    zoomLink: 'https://edu-il.zoom.us/j/85124349240#success',
    type: 'lesson',
    isRecurring: true,
    sendNotification: true,
    requireConfirmation: false,
  },
  {
    templateId: 'remote-learning-1-1000-amit-alin',
    dayIndex: 1,
    time: '10:00',
    child: 'amit_alin',
    title: 'למידה מרחוק',
    zoomLink: 'https://edu-il.zoom.us/j/6205065886?pwd=RmlLdazm4FYC2zaBsTA5q0QbRtX43K.1#success',
    type: 'lesson',
    isRecurring: true,
    sendNotification: true,
    requireConfirmation: false,
  },
  {
    templateId: 'remote-learning-1-1200-amit-alin',
    dayIndex: 1,
    time: '12:00',
    child: 'amit_alin',
    title: 'למידה מרחוק',
    zoomLink: 'https://edu-il.zoom.us/j/3055190951#success',
    type: 'lesson',
    isRecurring: true,
    sendNotification: true,
    requireConfirmation: false,
  },
  {
    templateId: 'remote-learning-2-1000-amit-alin',
    dayIndex: 2,
    time: '10:00',
    child: 'amit_alin',
    title: 'למידה מרחוק',
    zoomLink: 'https://edu-il.zoom.us/j/85124349240#success',
    type: 'lesson',
    isRecurring: true,
    sendNotification: true,
    requireConfirmation: false,
  },
  {
    templateId: 'remote-learning-2-1200-amit-alin',
    dayIndex: 2,
    time: '12:00',
    child: 'amit_alin',
    title: 'למידה מרחוק',
    zoomLink: 'https://edu-il.zoom.us/j/85124349240#success',
    type: 'lesson',
    isRecurring: true,
    sendNotification: true,
    requireConfirmation: false,
  },
  {
    templateId: 'remote-learning-3-1000-amit-alin',
    dayIndex: 3,
    time: '10:00',
    child: 'amit_alin',
    title: 'למידה מרחוק',
    zoomLink: 'https://edu-il.zoom.us/j/3055190951#success',
    type: 'lesson',
    isRecurring: true,
    sendNotification: true,
    requireConfirmation: false,
  },
  {
    templateId: 'remote-learning-3-1200-amit-alin',
    dayIndex: 3,
    time: '12:00',
    child: 'amit_alin',
    title: 'למידה מרחוק',
    zoomLink: 'https://edu-il.zoom.us/j/3055190951#success',
    type: 'lesson',
    isRecurring: true,
    sendNotification: true,
    requireConfirmation: false,
  },
  {
    templateId: 'remote-learning-4-1000-amit-alin',
    dayIndex: 4,
    time: '10:00',
    child: 'amit_alin',
    title: 'למידה מרחוק',
    zoomLink: 'https://edu-il.zoom.us/j/85124349240#success',
    type: 'lesson',
    isRecurring: true,
    sendNotification: true,
    requireConfirmation: false,
  },
  {
    templateId: 'english-1-1500-amit',
    dayIndex: 1,
    time: '15:00',
    child: 'amit',
    title: 'אנגלית',
    type: 'lesson',
    isRecurring: true,
    sendNotification: true,
    requireConfirmation: false,
  },
  {
    templateId: 'english-2-1900-alin',
    dayIndex: 2,
    time: '19:00',
    child: 'alin',
    title: 'אנגלית',
    type: 'lesson',
    isRecurring: true,
    sendNotification: true,
    requireConfirmation: false,
  },
  {
    templateId: 'english-4-1400-amit',
    dayIndex: 4,
    time: '14:00',
    child: 'amit',
    title: 'אנגלית',
    type: 'lesson',
    isRecurring: true,
    sendNotification: true,
    requireConfirmation: false,
  },
];

const mergeRecurringTemplatesWithDefaults = (templates: RecurringTemplate[]) => {
  const dedupeKey = (template: RecurringTemplate) => {
    const normalizedZoom = (template.zoomLink || '').trim();
    return `${template.dayIndex}|${normalizeTimeForPicker(template.time)}|${template.child}|${template.title.trim()}|${normalizedZoom}`;
  };

  const merged = [...templates];
  const existingKeys = new Set(templates.map(dedupeKey));
  remoteLearningTemplates.forEach((template) => {
    const key = dedupeKey(template);
    if (!existingKeys.has(key)) {
      merged.push(template);
      existingKeys.add(key);
    }
  });

  return merged;
};

const getSaturdayJohnnyAssignment = (weekStart: Date): { morning: BaseChildKey; afternoon: BaseChildKey } => {
  const reference = new Date('2026-02-15T00:00:00');
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const diffWeeks = Math.floor((getWeekStart(weekStart).getTime() - reference.getTime()) / weekMs);
  const cycle: Array<{ morning: BaseChildKey; afternoon: BaseChildKey }> = [
    { morning: 'alin', afternoon: 'amit' },
    { morning: 'ravid', afternoon: 'alin' },
    { morning: 'amit', afternoon: 'ravid' },
    { morning: 'amit', afternoon: 'alin' },
    { morning: 'alin', afternoon: 'ravid' },
    { morning: 'ravid', afternoon: 'amit' },
  ];
  const index = ((diffWeeks % cycle.length) + cycle.length) % cycle.length;
  return cycle[index];
};

const buildJohnnyEvents = (
  weekStart: Date,
  suppressedIds?: Set<string>,
): Array<{ dayIndex: number; event: SchedulerEvent }> => {
  const saturdayAssignment = getSaturdayJohnnyAssignment(weekStart);
  const dateForDay = (dayIndex: number) => toEventDateKey(addDays(weekStart, dayIndex));
  const slots: Array<{ dayIndex: number; event: SchedulerEvent }> = [
    {
      dayIndex: 0,
      event: createJohnnyEvent(weekStart, 0, { date: dateForDay(0), time: '08:00', child: 'amit', title: 'התור של ג׳וני (בוקר)', type: 'dog', isRecurring: true }),
    },
    {
      dayIndex: 0,
      event: createJohnnyEvent(weekStart, 0, { date: dateForDay(0), time: '13:00', child: 'amit', title: 'התור של ג׳וני (צהריים)', type: 'dog', isRecurring: true }),
    },
    {
      dayIndex: 1,
      event: createJohnnyEvent(weekStart, 1, { date: dateForDay(1), time: '08:00', child: 'alin', title: 'התור של ג׳וני (בוקר)', type: 'dog', isRecurring: true }),
    },
    {
      dayIndex: 1,
      event: createJohnnyEvent(weekStart, 1, { date: dateForDay(1), time: '13:00', child: 'ravid', title: 'התור של ג׳וני (צהריים)', type: 'dog', isRecurring: true }),
    },
    {
      dayIndex: 2,
      event: createJohnnyEvent(weekStart, 2, { date: dateForDay(2), time: '08:00', child: 'amit', title: 'התור של ג׳וני (בוקר)', type: 'dog', isRecurring: true }),
    },
    {
      dayIndex: 2,
      event: createJohnnyEvent(weekStart, 2, { date: dateForDay(2), time: '13:00', child: 'amit', title: 'התור של ג׳וני (צהריים)', type: 'dog', isRecurring: true }),
    },
    {
      dayIndex: 3,
      event: createJohnnyEvent(weekStart, 3, { date: dateForDay(3), time: '08:00', child: 'alin', title: 'התור של ג׳וני (בוקר)', type: 'dog', isRecurring: true }),
    },
    {
      dayIndex: 3,
      event: createJohnnyEvent(weekStart, 3, { date: dateForDay(3), time: '13:00', child: 'ravid', title: 'התור של ג׳וני (צהריים)', type: 'dog', isRecurring: true }),
    },
    {
      dayIndex: 4,
      event: createJohnnyEvent(weekStart, 4, { date: dateForDay(4), time: '08:00', child: 'amit', title: 'התור של ג׳וני (בוקר)', type: 'dog', isRecurring: true }),
    },
    {
      dayIndex: 4,
      event: createJohnnyEvent(weekStart, 4, { date: dateForDay(4), time: '13:00', child: 'ravid', title: 'התור של ג׳וני (צהריים)', type: 'dog', isRecurring: true }),
    },
    {
      dayIndex: 5,
      event: createJohnnyEvent(weekStart, 5, { date: dateForDay(5), time: '08:00', child: 'alin', title: 'התור של ג׳וני (בוקר)', type: 'dog', isRecurring: true }),
    },
    {
      dayIndex: 5,
      event: createJohnnyEvent(weekStart, 5, { date: dateForDay(5), time: '13:00', child: 'ravid', title: 'התור של ג׳וני (צהריים)', type: 'dog', isRecurring: true }),
    },
    {
      dayIndex: 6,
      event: createJohnnyEvent(weekStart, 6, { date: dateForDay(6), time: '08:00', child: saturdayAssignment.morning, title: 'הורדת ג׳וני (בוקר)', type: 'dog', isRecurring: true }),
    },
    {
      dayIndex: 6,
      event: createJohnnyEvent(weekStart, 6, { date: dateForDay(6), time: '13:00', child: saturdayAssignment.afternoon, title: 'הורדת ג׳וני (צהריים)', type: 'dog', isRecurring: true }),
    },
  ];
  return slots.filter((item) => !suppressedIds?.has(item.event.id));
};

const sortEvents = (events: SchedulerEvent[]) => {
  const score = (time: string) => {
    const match = time.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) {
      return Number.MAX_SAFE_INTEGER;
    }
    return Number(match[1]) * 60 + Number(match[2]);
  };

  return [...events].sort((a, b) => score(a.time) - score(b.time));
};

type CreateWeekDaysOptions = {
  /** When true, only use templates from the caller (e.g. DB refetch). Skips merging built-in defaults like remote-learning — otherwise deleted recurring items would reappear after every refresh. */
  skipDefaultRecurringTemplates?: boolean;
  /** Slots whose built-in Johnny row was deleted — ids are `johnny-${weekKey}-…` from johnnyStableEventId. */
  johnnySuppressedIds?: Set<string>;
};

const createWeekDays = (
  weekStart: Date,
  includeDemo: boolean,
  recurringTemplates: RecurringTemplate[],
  options?: CreateWeekDaysOptions
): DaySchedule[] => {
  const mergedRecurringTemplates = options?.skipDefaultRecurringTemplates
    ? recurringTemplates
    : mergeRecurringTemplatesWithDefaults(recurringTemplates);
  const days: DaySchedule[] = dayNames.map((dayName, idx) => {
    const date = addDays(weekStart, idx);
    return {
      date: toDisplayDate(date),
      dayName,
      isoDate: toIsoDate(date),
      events: [],
    };
  });

  const addEvent = (dayIndex: number, event: SchedulerEvent) => {
    const fallbackDate = new Date(`${days[dayIndex].isoDate}T00:00:00`);
    days[dayIndex].events.push({
      ...event,
      date: normalizeEventDateKey(event.date, fallbackDate),
      isRecurring: Boolean(event.isRecurring),
      completed: Boolean(event.completed),
      sendNotification: event.sendNotification ?? true,
      requireConfirmation: Boolean(event.requireConfirmation),
      reminderLeadMinutes: sanitizeReminderLead(event.reminderLeadMinutes),
    });
  };

  buildJohnnyEvents(weekStart, options?.johnnySuppressedIds).forEach(({ dayIndex, event }) => addEvent(dayIndex, event));

  mergedRecurringTemplates
    .filter((template) => !template.title.includes('ג׳וני') && !template.title.includes("ג'וני"))
    .forEach((template) => {
    addEvent(template.dayIndex, {
      id: `${template.templateId}-${toIsoDate(weekStart)}`,
      date: toEventDateKey(addDays(weekStart, template.dayIndex)),
      time: template.time,
      child: template.child,
      title: template.title,
      zoomLink: template.zoomLink,
      type: template.type,
      isRecurring: template.isRecurring,
      recurringTemplateId: template.templateId,
      sendNotification: template.sendNotification,
      requireConfirmation: template.requireConfirmation,
      reminderLeadMinutes: template.reminderLeadMinutes,
    });
    });

  if (includeDemo) {
    addEvent(0, createEvent({ date: toEventDateKey(new Date(`${days[0].isoDate}T00:00:00`)), time: '14:45', child: 'alin', title: 'תגבור פלא', type: 'lesson' }));
    addEvent(0, createEvent({ date: toEventDateKey(new Date(`${days[0].isoDate}T00:00:00`)), time: '17:30', child: 'ravid', title: 'אימון', type: 'gym' }));
    addEvent(0, createEvent({ date: toEventDateKey(new Date(`${days[0].isoDate}T00:00:00`)), time: '18:00', child: 'amit', title: 'כדורסל', type: 'sport' }));
    addEvent(1, createEvent({ date: toEventDateKey(new Date(`${days[1].isoDate}T00:00:00`)), time: '15:00', child: 'amit', title: 'אנגלית: עמית (קארל)', type: 'lesson' }));
    addEvent(1, createEvent({ date: toEventDateKey(new Date(`${days[1].isoDate}T00:00:00`)), time: '17:00', child: 'alin', title: 'ריקוד אלין', type: 'dance' }));
  }

  days.forEach((day) => {
    day.events = sortEvents(day.events);
  });

  return days;
};

const getEventIcon = (eventType: EventType, title?: string) => {
  const source = `${eventType} ${title || ''}`;
  if (/אימון\s*מצוינות/i.test(source)) return <Trophy size={18} />;
  if (/dog|כלב|ג׳וני|ג'וני/i.test(source)) return <Dog size={18} />;
  if (/gym|כושר|אימון|מצוינות/i.test(source)) return <Dumbbell size={18} />;
  if (/sport|כדורסל|משחק|אולם/i.test(source)) return <Trophy size={18} />;
  if (/lesson|שיעור|תגבור|אנגלית|rachel|karl/i.test(source)) return <GraduationCap size={18} />;
  if (/other|אחר/i.test(source)) return <Music size={18} />;
  if (/dance|ריקוד/i.test(source)) return <Music size={18} />;
  return <Music size={18} />;
};

export default function FamilyScheduler() {
  const initialWeekStart = useMemo(() => getWeekStart(new Date()), []);
  const initialWeekKey = useMemo(() => toIsoDate(initialWeekStart), [initialWeekStart]);

  const [inputText, setInputText] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [apiError, setApiError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [selectedImagePreview, setSelectedImagePreview] = useState<string | null>(null);
  const [dbSyncStatus, setDbSyncStatus] = useState<{ state: 'idle' | 'saving' | 'saved' | 'error'; message: string }>({
    state: 'idle',
    message: '',
  });
  const [selectedChildFilter, setSelectedChildFilter] = useState<'all' | BaseChildKey>('all');
  const [settingsChildFilter, setSettingsChildFilter] = useState<'all' | BaseChildKey>('all');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [weekStart, setWeekStart] = useState(initialWeekStart);
  const [recurringTemplates, setRecurringTemplates] = useState<RecurringTemplate[]>([]);
  const [weeksData, setWeeksData] = useState<Record<string, DaySchedule[]>>(() => ({
    [initialWeekKey]: createEmptyWeekDays(initialWeekStart),
  }));
  const [scheduleLoadedWeekKey, setScheduleLoadedWeekKey] = useState<string | null>(null);
  const [editingEvent, setEditingEvent] = useState<{
    sourceWeekKey: string;
    dayIndex: number;
    selectedDate: string;
    data: SchedulerEvent;
    recurringWeekly: boolean;
    originalRecurringTemplateId?: string;
  } | null>(null);
  const [creatingEvent, setCreatingEvent] = useState<NewEventDraft | null>(null);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showUpcomingListModal, setShowUpcomingListModal] = useState(false);
  const [upcomingListLoading, setUpcomingListLoading] = useState(false);
  const [upcomingListEvents, setUpcomingListEvents] = useState<ScheduleApiEvent[]>([]);
  const [deletePasswordModalOpen, setDeletePasswordModalOpen] = useState(false);
  const [deletePasswordInput, setDeletePasswordInput] = useState('');
  const deletePasswordResolverRef = useRef<((value: string | null) => void) | null>(null);
  const [pushSupported, setPushSupported] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushTestBusy, setPushTestBusy] = useState(false);
  const [exportImageBusy, setExportImageBusy] = useState(false);
  const [presenceBusy, setPresenceBusy] = useState(false);
  const [presenceUsers, setPresenceUsers] = useState<PresenceUser[]>([]);
  const [pushRavidTestBusy, setPushRavidTestBusy] = useState(false);
  const [confirmingEventId, setConfirmingEventId] = useState('');
  const [confirmingReminderSeen, setConfirmingReminderSeen] = useState(false);
  const [pendingReminderConfirmation, setPendingReminderConfirmation] = useState<{
    eventId: string;
    childName: string;
    eventTitle: string;
  } | null>(null);
  const [showPushIdentityPrompt, setShowPushIdentityPrompt] = useState(false);
  const [pushUserName, setPushUserName] = useState<PushUserName | ''>('');
  const [hasConfirmedPushIdentitySelection, setHasConfirmedPushIdentitySelection] = useState(false);
  const [hasLoadedPushUser, setHasLoadedPushUser] = useState(false);
  const [parentReceiveAll, setParentReceiveAll] = useState(true);
  const [parentWatchChildren, setParentWatchChildren] = useState<PushChildName[]>(['רביד', 'עמית', 'אלין']);
  const [reminderLeadMinutes, setReminderLeadMinutes] = useState<ReminderLeadMinutes>(defaultPushLeadMinutes);
  const [pushSound, setPushSound] = useState<PushSoundPreset>(defaultPushSound);
  const [installPromptEvent, setInstallPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstallReady, setIsInstallReady] = useState(false);
  const [, setSubscriptionEndpoint] = useState("");
  const persistDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestInFlightRef = useRef(false);
  const lastApiRequestAtRef = useRef<number>(0);
  const hasLoadedStorageRef = useRef(false);
  const [isHydrated, setIsHydrated] = useState(false);
  const autoRefetchInFlightRef = useRef(false);
  const autoRefetchWeekKeyRef = useRef<string>('');
  const dayCardRefs = useRef<Array<HTMLDivElement | null>>([]);
  const hasAutoScrolledToTodayRef = useRef(false);
  const autoSyncPushProfileInFlightRef = useRef(false);
  const canViewPresencePanel = isParentPushUser(pushUserName);

  const weekKey = toIsoDate(weekStart);
  const days = weeksData[weekKey] ?? [];
  const showScheduleLoading = isHydrated && scheduleLoadedWeekKey !== weekKey;
  const activeChildFilter = normalizeChildFilterValue(selectedChildFilter);
  const notificationsApproved = pushEnabled || (typeof Notification !== 'undefined' && Notification.permission === 'granted');

  useEffect(() => {
    if (!showSettingsModal) {
      return;
    }
    setSettingsChildFilter(normalizeChildFilterValue(selectedChildFilter));
  }, [showSettingsModal, selectedChildFilter]);

  useEffect(() => {
    const readPendingConfirmationFromUrl = () => {
      if (typeof window === 'undefined') {
        return;
      }

      const params = new URLSearchParams(window.location.search);
      const eventId = params.get('confirmEventId')?.trim() || '';
      if (!eventId) {
        return;
      }

      const childName = params.get('confirmChildName')?.trim() || '';
      const eventTitle = params.get('confirmEventTitle')?.trim() || '';
      setPendingReminderConfirmation({ eventId, childName, eventTitle });
    };

    readPendingConfirmationFromUrl();
    window.addEventListener('popstate', readPendingConfirmationFromUrl);
    window.addEventListener('focus', readPendingConfirmationFromUrl);
    return () => {
      window.removeEventListener('popstate', readPendingConfirmationFromUrl);
      window.removeEventListener('focus', readPendingConfirmationFromUrl);
    };
  }, []);

  const saveSettingsChildFilter = () => {
    setSelectedChildFilter(normalizeChildFilterValue(settingsChildFilter));
    setSuccessMessage('סינון התצוגה נשמר.');
    setShowSettingsModal(false);
    if (apiError) {
      setApiError('');
    }
  };

  const formatPresenceLastSeen = (value: string | null, isOnline: boolean) => {
    if (isOnline) {
      return 'פעיל עכשיו';
    }

    if (!value) {
      return 'לא נראה לאחרונה';
    }

    const diffMs = Date.now() - new Date(value).getTime();
    if (!Number.isFinite(diffMs) || diffMs < 0) {
      return 'נראה לאחרונה לא ידוע';
    }

    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 1) {
      return 'נראה לאחרונה עכשיו';
    }

    if (minutes < 60) {
      return `נראה לאחרונה לפני ${minutes} דק׳`;
    }

    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return `נראה לאחרונה לפני ${hours} שעות`;
    }

    const daysAgo = Math.floor(hours / 24);
    return `נראה לאחרונה לפני ${daysAgo} ימים`;
  };

  const refreshPresenceUsers = useCallback(async () => {
    if (!showSettingsModal || !canViewPresencePanel) {
      setPresenceUsers([]);
      return;
    }

    setPresenceBusy(true);
    try {
      const response = await fetch(toApiUrl('/api/presence'), { cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error || 'טעינת סטטוס משתמשים נכשלה');
      }

      const normalized = (Array.isArray(payload?.users) ? payload.users : [])
        .map((row: unknown) => {
          const candidate = row && typeof row === 'object' ? row as Record<string, unknown> : {};
          const userName = typeof candidate.userName === 'string' ? candidate.userName as PushUserName : null;
          if (!userName || !pushUserOptions.includes(userName)) {
            return null;
          }

          return {
            userName,
            registered: Boolean(candidate.registered),
            hasSubscription: Boolean(candidate.hasSubscription),
            isOnline: Boolean(candidate.isOnline),
            lastSeen: typeof candidate.lastSeen === 'string' ? candidate.lastSeen : null,
          } as PresenceUser;
        })
        .filter((row: PresenceUser | null): row is PresenceUser => Boolean(row));

      setPresenceUsers(normalized);
    } catch {
      setPresenceUsers([]);
    } finally {
      setPresenceBusy(false);
    }
  }, [showSettingsModal, canViewPresencePanel]);

  const sendPresenceHeartbeat = useCallback(async () => {
    if (!pushUserName) {
      return;
    }

    await fetch(toApiUrl('/api/presence'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName: pushUserName }),
    }).catch(() => undefined);
  }, [pushUserName]);

  const playPushSound = (soundUrl: string) => {
    if (typeof window === 'undefined') {
      return;
    }

    const audio = new Audio(soundUrl);
    audio.volume = 0.85;
    void audio.play().catch(() => undefined);
  };

  const ensureServiceWorkerRegistration = useCallback(async () => {
    if (!("serviceWorker" in navigator)) {
      return null;
    }

    const existing = await navigator.serviceWorker.getRegistration();
    const activeScriptUrl = existing?.active?.scriptURL || existing?.waiting?.scriptURL || existing?.installing?.scriptURL || '';
    if (existing && activeScriptUrl.includes(SERVICE_WORKER_URL)) {
      await existing.update().catch(() => undefined);
      if (existing.waiting) {
        existing.waiting.postMessage({ type: 'SKIP_WAITING' });
      }
      return existing;
    }

    const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL);
    if (registration.waiting) {
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    }

    return registration;
  }, []);

  const syncPushPreferencesToServiceWorker = useCallback(async () => {
    if (!("serviceWorker" in navigator)) {
      return;
    }

    const registration = await ensureServiceWorkerRegistration();
    if (!registration) {
      return;
    }

    const message = {
      type: 'PUSH_PREFERENCES',
      payload: {
        reminderLeadMinutes,
        sound: pushSound,
      },
    };

    if (registration.active) {
      registration.active.postMessage(message);
      return;
    }

    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage(message);
    }
  }, [ensureServiceWorkerRegistration, reminderLeadMinutes, pushSound]);

  useEffect(() => {
    setWeeksData((prev) => {
      if (prev[weekKey]) {
        return prev;
      }
      return {
        ...prev,
        [weekKey]: createWeekDays(weekStart, false, recurringTemplates, {
          skipDefaultRecurringTemplates: true,
        }),
      };
    });
  }, [weekKey, weekStart, recurringTemplates]);

  useEffect(() => {
    if (!showSettingsModal) {
      return;
    }

    void refreshPresenceUsers();
    const timer = setInterval(() => {
      void refreshPresenceUsers();
    }, 30_000);

    return () => {
      clearInterval(timer);
    };
  }, [showSettingsModal, refreshPresenceUsers]);

  useEffect(() => {
    if (!pushUserName) {
      return;
    }

    const ping = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        return;
      }
      void sendPresenceHeartbeat();
    };

    ping();
    const timer = setInterval(ping, 45_000);
    const onFocus = () => ping();
    const onVisible = () => ping();

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [pushUserName, sendPresenceHeartbeat]);

  useEffect(() => {
    let cancelled = false;

    const hydrateState = async () => {
      try {
        const response = await fetch(toApiUrl('/api/state'), { cache: 'no-store' });
        if (response.ok) {
          const payload = await response.json() as { state?: PersistedStatePayload };
          if (payload?.state && !cancelled) {
            const normalized = normalizePersistedState(payload.state, initialWeekStart);
            setWeekStart(normalized.weekStart);
            setRecurringTemplates(normalized.recurringTemplates);
            setWeeksData(normalized.weeksData);
            return;
          }
        }
      } catch {
        // ignore and fallback to localStorage
      }

      try {
        const raw = localStorage.getItem(SCHEDULER_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) as PersistedStatePayload : null;
        const normalized = normalizePersistedState(parsed, initialWeekStart);
        if (!cancelled) {
          setWeekStart(normalized.weekStart);
          setRecurringTemplates(normalized.recurringTemplates);
          setWeeksData(normalized.weeksData);
        }
      } catch {
        if (!cancelled) {
          const fallbackWeek = initialWeekStart;
          setWeekStart(fallbackWeek);
          setRecurringTemplates([]);
          setWeeksData({
            [toIsoDate(fallbackWeek)]: createEmptyWeekDays(fallbackWeek),
          });
        }
      }
    };

    void hydrateState().finally(() => {
      if (!cancelled) {
        hasLoadedStorageRef.current = true;
        setIsHydrated(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [initialWeekStart]);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }

    const normalizedWeeksForPersist = normalizeWeekEventsWithDate(weeksData);

    const payload = {
      weekStart: weekStart.toISOString(),
      recurringTemplates,
      weeksData: normalizedWeeksForPersist,
    };

    try {
      localStorage.setItem(
        SCHEDULER_STORAGE_KEY,
        JSON.stringify(payload)
      );
    } catch {
      // no-op: keep app usable even if persistence fails
    }

    if (persistDebounceRef.current) {
      clearTimeout(persistDebounceRef.current);
    }

    persistDebounceRef.current = setTimeout(() => {
      void fetch(toApiUrl('/api/state'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => {
        // keep UI responsive even if server persistence fails
      });
    }, 120);
  }, [isHydrated, weekStart, recurringTemplates, weeksData]);


  useEffect(() => {
    return () => {
      if (persistDebounceRef.current) {
        clearTimeout(persistDebounceRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!selectedImage) {
      setSelectedImagePreview(null);
      return;
    }

    const objectUrl = URL.createObjectURL(selectedImage);
    setSelectedImagePreview(objectUrl);

    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [selectedImage]);

  useEffect(() => {
    if (creatingEvent || editingEvent) {
      setDbSyncStatus({ state: 'idle', message: '' });
    }
  }, [creatingEvent, editingEvent]);

  useEffect(() => {
    try {
      const rawPrefs = localStorage.getItem(NOTIFICATION_SETTINGS_STORAGE_KEY) || localStorage.getItem(PUSH_PREFS_STORAGE_KEY);
      if (!rawPrefs) {
        return;
      }

      const parsed = JSON.parse(rawPrefs) as { reminderLeadMinutes?: unknown; sound?: unknown };
      setReminderLeadMinutes(sanitizeReminderLead(parsed?.reminderLeadMinutes));
      setPushSound(sanitizePushSound(parsed?.sound));
    } catch {
      // no-op
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(NOTIFICATION_SETTINGS_STORAGE_KEY, JSON.stringify({
        reminderLeadMinutes,
        sound: pushSound,
      }));
      localStorage.setItem(PUSH_PREFS_STORAGE_KEY, JSON.stringify({
        reminderLeadMinutes,
        sound: pushSound,
      }));
    } catch {
      // no-op
    }

    void syncPushPreferencesToServiceWorker().catch(() => undefined);
  }, [reminderLeadMinutes, pushSound, syncPushPreferencesToServiceWorker]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
      return;
    }

    const onWorkerMessage = (event: MessageEvent) => {
      const data = event.data as {
        type?: string;
        payload?: { sound?: string; eventId?: string; childName?: string; eventTitle?: string };
      } | undefined;

      if (data?.type === 'PLAY_PUSH_SOUND') {
        const selectedSound = (typeof data?.payload?.sound === 'string' && data.payload.sound)
          ? data.payload.sound
          : pushSound;
        playPushSound(selectedSound);
        return;
      }

      if (data?.type === 'TASK_CONFIRMED') {
        const eventId = typeof data?.payload?.eventId === 'string' ? data.payload.eventId.trim() : '';
        if (!eventId) {
          return;
        }

        setWeeksData((prev) => {
          const next: Record<string, DaySchedule[]> = {};
          Object.entries(prev).forEach(([key, scheduleDays]) => {
            next[key] = scheduleDays.map((day) => ({
              ...day,
              events: day.events.map((event) => (
                event.id === eventId ? { ...event, completed: true } : event
              )),
            }));
          });
          return next;
        });
        return;
      }

      if (data?.type === 'CONFIRM_REQUIRED') {
        const eventId = typeof data?.payload?.eventId === 'string' ? data.payload.eventId.trim() : '';
        if (!eventId) {
          return;
        }

        setPendingReminderConfirmation({
          eventId,
          childName: typeof data?.payload?.childName === 'string' ? data.payload.childName.trim() : '',
          eventTitle: typeof data?.payload?.eventTitle === 'string' ? data.payload.eventTitle.trim() : '',
        });
      }
    };

    navigator.serviceWorker.addEventListener('message', onWorkerMessage);
    return () => {
      navigator.serviceWorker.removeEventListener('message', onWorkerMessage);
    };
  }, [pushSound]);

  useEffect(() => {
    let cancelled = false;

    const setupPush = async () => {
      if (!("serviceWorker" in navigator)) {
        return;
      }

      const supportsPush = "PushManager" in window && "Notification" in window;
      setPushSupported(supportsPush);

      try {
        const migrationDone = localStorage.getItem(PUSH_MIGRATION_FLAG_KEY) === '1';
        if (!migrationDone && supportsPush) {
          const savedUser = localStorage.getItem(PUSH_USER_STORAGE_KEY) || '';
          const hasKnownUser = pushUserOptions.includes(savedUser as PushUserName);
          if (hasKnownUser) {
            localStorage.setItem(PUSH_MIGRATION_FLAG_KEY, '1');
          } else {
            const migrationRegistration = await ensureServiceWorkerRegistration();
            const oldSubscription = migrationRegistration
              ? await migrationRegistration.pushManager.getSubscription()
              : null;

            if (oldSubscription) {
              const serialized = oldSubscription.toJSON();
              const endpoint = serialized.endpoint || oldSubscription.endpoint || '';
              if (endpoint) {
                await fetch(toApiUrl('/api/notifications/subscribe'), {
                  method: 'DELETE',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ endpoint }),
                }).catch(() => undefined);
              }

              await oldSubscription.unsubscribe().catch(() => undefined);
              if (!cancelled) {
                setPushEnabled(false);
                setSubscriptionEndpoint('');
                setSuccessMessage('בוצע רענון חד-פעמי להתראות. יש להפעיל מחדש ולבחור משתמש.');
              }
            }

            localStorage.setItem(PUSH_MIGRATION_FLAG_KEY, '1');
          }
        }

        const registration = await ensureServiceWorkerRegistration();
        if (!registration || !supportsPush) {
          return;
        }

        const configResponse = await fetch(toApiUrl('/api/notifications/subscribe'), { cache: 'no-store' });
        const configPayload = await configResponse.json();
        if (!configResponse.ok || !configPayload?.enabled || !configPayload?.publicKey) {
          return;
        }

        const existing = await registration.pushManager.getSubscription();
        if (!existing) {
          return;
        }

        const serialized = existing.toJSON();
        if (!cancelled) {
          setPushEnabled(true);
          setSubscriptionEndpoint(serialized.endpoint || '');
        }
      } catch {
      }
    };

    void setupPush();

    return () => {
      cancelled = true;
    };
  }, [ensureServiceWorkerRegistration]);

  useEffect(() => {
    const standalone = window.matchMedia('(display-mode: standalone)').matches || Boolean((window.navigator as Navigator & { standalone?: boolean }).standalone);
    if (standalone) {
      setIsInstallReady(false);
      return;
    }

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPromptEvent(event as BeforeInstallPromptEvent);
      setIsInstallReady(true);
    };

    const handleInstalled = () => {
      setInstallPromptEvent(null);
      setIsInstallReady(false);
      setSuccessMessage('האפליקציה הותקנה בהצלחה.');
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleInstalled);
    };
  }, []);

  const installApp = async () => {
    if (!installPromptEvent) {
      return;
    }

    try {
      await installPromptEvent.prompt();
      const result = await installPromptEvent.userChoice;
      if (result.outcome === 'accepted') {
        setSuccessMessage('ההתקנה הופעלה בהצלחה.');
      }
    } finally {
      setInstallPromptEvent(null);
      setIsInstallReady(false);
    }
  };

  const toggleParentTrackedChild = (child: PushChildName) => {
    setParentWatchChildren((prev) => {
      if (prev.includes(child)) {
        return prev.filter((value) => value !== child);
      }
      return [...prev, child];
    });
  };

  const selectPushUser = (user: PushUserName) => {
    setPushUserName(user);
    setHasConfirmedPushIdentitySelection(true);
    try {
      localStorage.setItem(PUSH_USER_STORAGE_KEY, user);
    } catch {
      // no-op
    }

    if (isParentUserOption(user)) {
      setParentReceiveAll(true);
      setParentWatchChildren(['רביד', 'עמית', 'אלין']);
    }
  };

  useEffect(() => {
    try {
      const savedUser = localStorage.getItem(PUSH_USER_STORAGE_KEY);
      if (!savedUser) {
        setHasLoadedPushUser(true);
        return;
      }

      if (pushUserOptions.includes(savedUser as PushUserName)) {
        const user = savedUser as PushUserName;
        setPushUserName(user);
        setHasConfirmedPushIdentitySelection(true);
        setShowPushIdentityPrompt(false);
        if (isParentUserOption(user)) {
          setParentReceiveAll(true);
          setParentWatchChildren(['רביד', 'עמית', 'אלין']);
        }
      }
    } catch {
      // no-op
    } finally {
      setHasLoadedPushUser(true);
    }
  }, []);

  useEffect(() => {
    if (!hasLoadedPushUser) {
      return;
    }

    if (pushUserName) {
      setShowPushIdentityPrompt(false);
      return;
    }

    setHasConfirmedPushIdentitySelection(false);
    setShowPushIdentityPrompt(true);
  }, [pushUserName, hasLoadedPushUser]);

  const openPushIdentityPrompt = () => {
    if (pushBusy) {
      return;
    }

    setApiError('');
    setHasConfirmedPushIdentitySelection(false);
    setShowPushIdentityPrompt(true);
  };

  const savePushSubscriptionProfile = async (serialized: PushSubscriptionJSON) => {
    const selectedUserName = typeof pushUserName === 'string' ? pushUserName.trim() : '';
    if (!selectedUserName) {
      throw new Error('יש לבחור שם משתמש לפני הפעלת התראות.');
    }

    const isParent = isParentPushUser(pushUserName);
    const receiveAll = isParent ? parentReceiveAll : false;
    const watchChildren = isParent && !receiveAll ? parentWatchChildren : [];

    const saveResponse = await fetch(toApiUrl('/api/notifications/subscribe'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: serialized,
        userName: selectedUserName,
        receiveAll,
        watchChildren,
        reminderLeadMinutes,
      }),
    });

    if (!saveResponse.ok) {
      const body = await saveResponse.json().catch(() => ({}));
      throw new Error(body?.error || 'Failed to save notification subscription');
    }

    const savedBody = await saveResponse.json().catch(() => ({}));
    if (typeof savedBody?.userName === 'string' && savedBody.userName.trim() !== selectedUserName) {
      throw new Error('שמירת שם המשתמש בהרשמת ההתראות נכשלה.');
    }
  };

  const ensureNotificationPermission = async () => {
    if (!("Notification" in window)) {
      setApiError('התראות אינן נתמכות כרגע בדפדפן במכשיר זה.');
      return false;
    }

    const currentPermission = Notification.permission;
    if (currentPermission === 'granted') {
      return true;
    }

    if (currentPermission === 'denied') {
      setApiError('ההתראות חסומות בדפדפן. יש לאפשר התראות בהגדרות הדפדפן.');
      return false;
    }

    const requestedPermission = await Notification.requestPermission();
    if (requestedPermission !== 'granted') {
      setApiError('לא אושרו התראות בדפדפן.');
      return false;
    }

    return true;
  };

  const updatePushProfileForExistingSubscription = async () => {
    if (pushBusy) {
      return;
    }

    if (!pushSupported) {
      setApiError('התראות אינן נתמכות כרגע בדפדפן במכשיר זה.');
      return;
    }

    setPushBusy(true);
    try {
      const registration = await ensureServiceWorkerRegistration();
      if (!registration) {
        setApiError('Service Worker לא זמין בדפדפן זה.');
        return;
      }

      let existing = await registration.pushManager.getSubscription();
      if (!existing) {
        const hasPermission = await ensureNotificationPermission();
        if (!hasPermission) {
          return;
        }

        const configResponse = await fetch(toApiUrl('/api/notifications/subscribe'), { cache: 'no-store' });
        const configPayload = await configResponse.json();
        if (!configResponse.ok || !configPayload?.enabled || !configPayload?.publicKey) {
          setApiError('התראות אינן זמינות כרגע בשרת.');
          return;
        }

        existing = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(String(configPayload.publicKey)),
        });
      }

      const serialized = existing.toJSON();
      await savePushSubscriptionProfile(serialized);
      setPushEnabled(true);
      setSubscriptionEndpoint(serialized.endpoint || '');
      setSuccessMessage('פרופיל ההתראות עודכן בהצלחה.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'עדכון פרופיל התראות נכשל';
      setApiError(message);
    } finally {
      setPushBusy(false);
    }
  };

  const confirmEnablePushNotifications = async () => {
    if (!pushUserName || !hasConfirmedPushIdentitySelection) {
      setApiError('בחר מי אתה כדי להפעיל התראות.');
      return;
    }

    if (isParentPushUser(pushUserName) && !parentReceiveAll && parentWatchChildren.length === 0) {
      setApiError('בחר לפחות ילד אחד למעקב או סמן קבלת התראות לכולם.');
      return;
    }

    setShowPushIdentityPrompt(false);

    if (pushEnabled) {
      await updatePushProfileForExistingSubscription();
    } else {
      await enablePushNotifications();
    }
  };

  const enablePushNotifications = async () => {
    if (pushBusy) {
      return;
    }

    if (!pushSupported) {
      setApiError('התראות אינן נתמכות כרגע בדפדפן במכשיר זה.');
      return;
    }

    if (!pushUserName) {
      openPushIdentityPrompt();
      return;
    }

    setPushBusy(true);
    try {
      const hasPermission = await ensureNotificationPermission();
      if (!hasPermission) {
        return;
      }

      const registration = await ensureServiceWorkerRegistration();
      if (!registration) {
        setApiError('Service Worker לא זמין בדפדפן זה.');
        return;
      }

      const configResponse = await fetch(toApiUrl('/api/notifications/subscribe'), { cache: 'no-store' });
      const configPayload = await configResponse.json();
      if (!configResponse.ok || !configPayload?.enabled || !configPayload?.publicKey) {
        setApiError('התראות אינן זמינות כרגע בשרת.');
        return;
      }

      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(String(configPayload.publicKey)),
        });
      }

      const serialized = subscription.toJSON();
      await savePushSubscriptionProfile(serialized);

      setPushEnabled(true);
      setSubscriptionEndpoint(serialized.endpoint || '');
      setSuccessMessage('התראות הופעלו בהצלחה.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'הפעלת התראות נכשלה';
      setApiError(message);
    } finally {
      setPushBusy(false);
    }
  };

  const ensurePushSubscriptionReady = async () => {
    if (!pushSupported) {
      setApiError('התראות אינן נתמכות כרגע בדפדפן במכשיר זה.');
      return false;
    }

    if (!pushUserName) {
      openPushIdentityPrompt();
      return false;
    }

    const registration = await ensureServiceWorkerRegistration();
    if (!registration) {
      setApiError('Service Worker לא זמין בדפדפן זה.');
      return false;
    }

    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      const hasPermission = await ensureNotificationPermission();
      if (!hasPermission) {
        return false;
      }

      const configResponse = await fetch(toApiUrl('/api/notifications/subscribe'), { cache: 'no-store' });
      const configPayload = await configResponse.json();
      if (!configResponse.ok || !configPayload?.enabled || !configPayload?.publicKey) {
        setApiError('התראות אינן זמינות כרגע בשרת.');
        return false;
      }

      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(String(configPayload.publicKey)),
      });
    }

    const serialized = subscription.toJSON();
    await savePushSubscriptionProfile(serialized);
    setPushEnabled(true);
    setSubscriptionEndpoint(serialized.endpoint || '');
    return true;
  };

  useEffect(() => {
    if (!pushEnabled || !pushSupported || !pushUserName || showPushIdentityPrompt) {
      return;
    }

    if (autoSyncPushProfileInFlightRef.current) {
      return;
    }

    autoSyncPushProfileInFlightRef.current = true;
    const syncProfile = async () => {
      try {
        const registration = await ensureServiceWorkerRegistration();
        if (!registration) {
          return;
        }

        const existing = await registration.pushManager.getSubscription();
        if (!existing) {
          return;
        }

        const serialized = existing.toJSON();
        await savePushSubscriptionProfile(serialized);
        setSubscriptionEndpoint(serialized.endpoint || '');
      } catch {
        // no-op
      } finally {
        autoSyncPushProfileInFlightRef.current = false;
      }
    };

    void syncProfile();
  }, [
    pushEnabled,
    pushSupported,
    pushUserName,
    showPushIdentityPrompt,
    parentReceiveAll,
    parentWatchChildren,
    reminderLeadMinutes,
    ensureServiceWorkerRegistration,
  ]);

  const sendTestPushNotification = async () => {
    if (pushTestBusy) {
      return;
    }

    setPushTestBusy(true);
    try {
      const ready = await ensurePushSubscriptionReady();
      if (!ready) {
        return;
      }

      const response = await fetch(toApiUrl('/api/push/test'), {
        method: 'POST',
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error || 'שליחת התראת ניסיון נכשלה');
      }

      if (Number(payload?.sent || 0) === 0) {
        setApiError('לא נמצאו מנויים פעילים להתראות. הפעל התראות במכשיר ואז נסה שוב.');
        return;
      }

      setSuccessMessage('התראת ניסיון נשלחה בהצלחה.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'שליחת התראת ניסיון נכשלה';
      setApiError(message);
    } finally {
      setPushTestBusy(false);
    }
  };

  const selectedChildForDirectTest = (!isParentPushUser(pushUserName) && pushUserName)
    ? pushUserName
    : '';

  const sendDirectTestPushToSelectedChild = async () => {
    if (pushRavidTestBusy) {
      return;
    }

    if (!selectedChildForDirectTest) {
      setApiError('בחרו קודם משתמש ילד (רביד/עמית/אלין) כדי לשלוח בדיקה ישירה.');
      return;
    }

    setPushRavidTestBusy(true);
    try {
      const ready = await ensurePushSubscriptionReady();
      if (!ready) {
        return;
      }

      const response = await fetch(toApiUrl(`/api/push/test-ravid?childName=${encodeURIComponent(selectedChildForDirectTest)}`), {
        method: 'POST',
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error || `שליחת בדיקה ל${selectedChildForDirectTest} נכשלה`);
      }

      setSuccessMessage(`התראת בדיקה נשלחה ל${selectedChildForDirectTest}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : `שליחת בדיקה ל${selectedChildForDirectTest} נכשלה`;
      setApiError(message);
    } finally {
      setPushRavidTestBusy(false);
    }
  };

  const confirmReminderSeen = async () => {
    if (!pendingReminderConfirmation || confirmingReminderSeen) {
      return;
    }

    setConfirmingReminderSeen(true);
    try {
      const response = await fetch(toApiUrl('/api/notifications/ack'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: pendingReminderConfirmation.eventId,
          childName: pendingReminderConfirmation.childName,
          eventTitle: pendingReminderConfirmation.eventTitle,
        }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error || 'שליחת אישור צפייה נכשלה');
      }

      const confirmedEventId = pendingReminderConfirmation.eventId;
      setWeeksData((prev) => {
        const next: Record<string, DaySchedule[]> = {};
        Object.entries(prev).forEach(([key, scheduleDays]) => {
          next[key] = scheduleDays.map((day) => ({
            ...day,
            events: day.events.map((event) => (
              event.id === confirmedEventId ? { ...event, completed: true } : event
            )),
          }));
        });
        return next;
      });

      setPendingReminderConfirmation(null);
      if (typeof window !== 'undefined') {
        const nextUrl = new URL(window.location.href);
        nextUrl.searchParams.delete('confirmEventId');
        nextUrl.searchParams.delete('confirmChildName');
        nextUrl.searchParams.delete('confirmEventTitle');
        window.history.replaceState({}, '', `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
      }

      setSuccessMessage('האישור נשלח בהצלחה.');
      if (apiError) {
        setApiError('');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'שליחת אישור צפייה נכשלה';
      setApiError(message);
    } finally {
      setConfirmingReminderSeen(false);
    }
  };

  const confirmEventFromBoard = async (eventToConfirm: SchedulerEvent) => {
    if (confirmingEventId === eventToConfirm.id) {
      return;
    }

    setConfirmingEventId(eventToConfirm.id);
    try {
      const childName = (!isParentPushUser(pushUserName) && pushUserName)
        ? pushUserName
        : baseChildrenConfig[getChildKeys(eventToConfirm.child)[0]].name;

      const response = await fetch(toApiUrl('/api/notifications/ack'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: eventToConfirm.id,
          childName,
          eventTitle: eventToConfirm.title,
        }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error || 'שליחת אישור נכשלה');
      }

      setWeeksData((prev) => {
        const next: Record<string, DaySchedule[]> = {};
        Object.entries(prev).forEach(([key, scheduleDays]) => {
          next[key] = scheduleDays.map((day) => ({
            ...day,
            events: day.events.map((event) => (
              event.id === eventToConfirm.id ? { ...event, completed: true } : event
            )),
          }));
        });
        return next;
      });

      setSuccessMessage('האישור נשלח בהצלחה.');
      if (apiError) {
        setApiError('');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'שליחת אישור נכשלה';
      setApiError(message);
    } finally {
      setConfirmingEventId('');
    }
  };

  useEffect(() => {
    let isRunning = false;

    const triggerReminderCheck = async () => {
      if (isRunning) {
        return;
      }

      isRunning = true;
      try {
        await fetch(toApiUrl('/api/notifications/check?client=1'), {
          method: 'GET',
          cache: 'no-store',
        });
      } catch {
      } finally {
        isRunning = false;
      }
    };

    void triggerReminderCheck();
    const timer = setInterval(() => {
      void triggerReminderCheck();
    }, 60_000);

    return () => {
      clearInterval(timer);
    };
  }, []);

  const weekRangeLabel = `${toDisplayDate(weekStart)} - ${toDisplayDate(addDays(weekStart, 6))}`;

  const refetchEventsFromDatabase = async (targetWeekStart: Date) => {
    try {
      const weekStartIso = toIsoDate(targetWeekStart);
      const weekEndIso = toIsoDate(addDays(targetWeekStart, 6));
      const query = new URLSearchParams({
        weekStart: weekStartIso,
        start: weekStartIso,
        end: weekEndIso,
      });
      console.log('[API] GET /api/schedule -> start');
      const response = await fetch(toApiUrl(`/api/schedule?${query.toString()}`), { cache: 'no-store' });
      const payload = await response.json();
      console.log('[API] GET /api/schedule ->', response.status, payload);
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed fetching events');
      }

      const allEventsRaw = (Array.isArray(payload?.events) ? payload.events : []) as ScheduleApiEvent[];
      const johnnySuppressedIds = new Set(
        allEventsRaw
          .filter(
            (e) =>
              e.title === JOHNNY_SUPPRESSED_TITLE &&
              typeof e.id === 'string' &&
              e.id.startsWith('johnny-'),
          )
          .map((e) => e.id),
      );
      const allEvents = allEventsRaw.filter((e) => e.title !== JOHNNY_SUPPRESSED_TITLE);
      const recurringRows = allEvents.filter((event) => event.isRecurring === true);

    const templatesMap = new Map<string, RecurringTemplate>();
    recurringRows.forEach((event) => {
      const templateId = event.recurringTemplateId || event.id;
      if (!templatesMap.has(templateId)) {
        templatesMap.set(templateId, {
          templateId,
          dayIndex: event.dayIndex,
          time: normalizeTimeForPicker(event.time),
          child: event.child,
          title: event.title,
          zoomLink: event.zoomLink,
          type: event.type,
          isRecurring: true,
          sendNotification: event.sendNotification ?? true,
          requireConfirmation: Boolean(event.requireConfirmation),
          reminderLeadMinutes: sanitizeReminderLead(event.reminderLeadMinutes),
        });
      }
    });

      const templates = [...templatesMap.values()];
      const targetWeekKey = toIsoDate(targetWeekStart);
      const weekDays = createWeekDays(targetWeekStart, false, templates, {
        skipDefaultRecurringTemplates: true,
        johnnySuppressedIds,
      }).map((day) => ({
        ...day,
        events: [...day.events],
      }));

      allEvents
      .filter((event) => event.isRecurring !== true)
      .forEach((event) => {
        let eventDate = parseEventDateKey(event.date);
        const apiDay =
          Number.isInteger(event.dayIndex) && event.dayIndex >= 0 && event.dayIndex <= 6 ? event.dayIndex : null;
        if (!eventDate && apiDay !== null) {
          eventDate = addDays(targetWeekStart, apiDay);
        }
        if (!eventDate) {
          return;
        }
        let eventWeekKey = toIsoDate(getWeekStart(eventDate));
        if (eventWeekKey !== targetWeekKey && apiDay !== null) {
          const anchored = addDays(targetWeekStart, apiDay);
          if (toIsoDate(getWeekStart(anchored)) === targetWeekKey) {
            eventDate = anchored;
            eventWeekKey = targetWeekKey;
          }
        }
        if (eventWeekKey !== targetWeekKey) {
          return;
        }
        const dayIndex = eventDate.getDay();
        const mapped: SchedulerEvent = {
          id: event.id,
          date: toEventDateKey(eventDate),
          time: normalizeTimeForPicker(event.time),
          child: event.child,
          title: event.title,
          zoomLink: event.zoomLink,
          type: event.type,
          isRecurring: false,
          recurringTemplateId: undefined,
          completed: Boolean(event.completed),
          sendNotification: event.sendNotification ?? true,
          requireConfirmation: Boolean(event.requireConfirmation),
          reminderLeadMinutes: sanitizeReminderLead(event.reminderLeadMinutes),
        };
        const dayEvents = weekDays[dayIndex].events;
        const existingIdx = dayEvents.findIndex((e) => e.id === mapped.id);
        if (existingIdx >= 0) {
          dayEvents[existingIdx] = mapped;
        } else {
          dayEvents.push(mapped);
        }
        weekDays[dayIndex].events = sortEvents(dayEvents);
      });

      setRecurringTemplates(templates);
      setWeeksData((prev) => ({ ...prev, [targetWeekKey]: weekDays }));
    } catch (error) {
      console.error('[API] GET /api/schedule client failed', error);
      throw error;
    } finally {
      setScheduleLoadedWeekKey(toIsoDate(targetWeekStart));
    }
  };

  const handleManualRefresh = async () => {
    if (isRefreshing) {
      return;
    }

    setIsRefreshing(true);
    try {
      await refetchEventsFromDatabase(weekStart);
      setSuccessMessage('הלוח עודכן.');
      if (apiError) {
        setApiError('');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'רענון הלו״ז נכשל';
      setApiError(message);
    } finally {
      setIsRefreshing(false);
    }
  };

  const upsertEventToDatabase = async (event: SchedulerEvent, dayIndex: number) => {
    try {
      console.log('[API] POST /api/schedule -> start', event);
      const parsedEventDate = parseEventDateKey(event.date);
      const normalizedApiDate = parsedEventDate
        ? toIsoDate(parsedEventDate)
        : toIsoDate(getNextOccurrenceDate(dayIndex, new Date()));

      let response = await fetch(toApiUrl('/api/schedule'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: {
            ...event,
            date: normalizedApiDate,
            dayIndex,
            isRecurring: Boolean(event.isRecurring),
            recurringTemplateId: event.isRecurring ? event.recurringTemplateId : undefined,
          },
        }),
      });

      if (!response.ok && (response.status === 404 || response.status === 405)) {
        response = await fetch(toApiUrl('/api/schedule'), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: {
              ...event,
              date: normalizedApiDate,
              dayIndex,
              isRecurring: Boolean(event.isRecurring),
              recurringTemplateId: event.isRecurring ? event.recurringTemplateId : undefined,
            },
          }),
        });
      }

      const payload = await response.json();
      console.log('[API] POST /api/schedule ->', response.status, payload);
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed saving event');
      }

      return payload;
    } catch (error) {
      console.error('[API] POST /api/schedule client failed', error);
      throw error;
    }
  };

  const upsertJohnnyTombstone = async (source: SchedulerEvent, targetWeekStart: Date, dayIndex: number) => {
    const parsedEventDate = parseEventDateKey(source.date);
    const normalizedApiDate = parsedEventDate
      ? toIsoDate(parsedEventDate)
      : toIsoDate(addDays(targetWeekStart, dayIndex));
    const slotId = johnnyStableEventId(targetWeekStart, dayIndex, source.time);
    const tombstone: SchedulerEvent = {
      ...source,
      id: slotId,
      title: JOHNNY_SUPPRESSED_TITLE,
      isRecurring: false,
      recurringTemplateId: undefined,
      sendNotification: false,
    };
    const response = await fetch(toApiUrl('/api/schedule'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: {
          ...tombstone,
          date: normalizedApiDate,
          dayIndex,
        },
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.error || 'Failed saving Johnny tombstone');
    }
    return payload;
  };

  const deleteEventFromDatabase = async (payload: { eventId: string; recurringTemplateId?: string }, deletePassword: string) => {
    try {
      const eventId = payload.eventId.trim();
      const recurringTemplateId = payload.recurringTemplateId?.trim();
      console.log('[API] DELETE /api/schedule -> start', { eventId, recurringTemplateId });
      const query = new URLSearchParams();
      if (eventId) {
        query.set('id', eventId);
      }
      if (recurringTemplateId) {
        query.set('recurringTemplateId', recurringTemplateId);
      }

      const response = await fetch(toApiUrl(`/api/schedule?${query.toString()}`), {
        method: 'DELETE',
        headers: {
          'x-delete-password': deletePassword,
        },
      });
      const body = await response.json();
      console.log('[API] DELETE /api/schedule ->', response.status, body);
      if (!response.ok) {
        throw new Error(body?.error || 'Failed deleting event');
      }
    } catch (error) {
      console.error('[API] DELETE /api/schedule client failed', error);
      throw error;
    }
  };

  const setEventCompletionInDatabase = async (eventId: string, completed: boolean) => {
    const confirmer = !isParentPushUser(pushUserName) && pushUserName ? pushUserName : undefined;

    const response = await fetch(toApiUrl('/api/schedule'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: completed ? 'confirm' : 'unconfirm',
        eventId,
        confirmedBy: confirmer,
      }),
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.error || 'Failed updating completion');
    }

    return payload;
  };

  const handleSubmit = async (event: SchedulerEvent, dayIndex: number, targetWeekStart: Date) => {
    console.log('Action triggered:', 'save');
    setDbSyncStatus({ state: 'saving', message: 'שומר...' });
    try {
      await upsertEventToDatabase(event, dayIndex);
      await refetchEventsFromDatabase(targetWeekStart);

      setDbSyncStatus({ state: 'saved', message: 'נשמר' });
    } catch (error) {
      console.error('[API] handleSubmit failed', error);
      setDbSyncStatus({ state: 'error', message: 'שמירה נכשלה' });
      throw error;
    }
  };

  const requestDeletePassword = useCallback((): Promise<string | null> => {
    return new Promise((resolve) => {
      deletePasswordResolverRef.current = resolve;
      setDeletePasswordInput('');
      setDeletePasswordModalOpen(true);
    });
  }, []);

  const finishDeletePasswordModal = useCallback((value: string | null) => {
    const resolve = deletePasswordResolverRef.current;
    deletePasswordResolverRef.current = null;
    setDeletePasswordModalOpen(false);
    setDeletePasswordInput('');
    resolve?.(value);
  }, []);

  const confirmDeletePasswordFromModal = useCallback(() => {
    const trimmed = deletePasswordInput.trim();
    if (!trimmed) {
      setApiError('יש להזין סיסמת מחיקה.');
      return;
    }
    setApiError('');
    finishDeletePasswordModal(trimmed);
  }, [deletePasswordInput, finishDeletePasswordModal]);

  const verifySettingsResetPassword = () => {
    const entered = window.prompt('הקלידי סיסמה לאיפוס הגדרות');
    if (entered === null) {
      return false;
    }

    const trimmed = entered.trim();
    if (trimmed !== '2101') {
      setApiError('סיסמה שגויה. איפוס הגדרות בוטל.');
      return false;
    }

    return true;
  };

  const resetSettingsWithPassword = () => {
    if (!verifySettingsResetPassword()) {
      return;
    }

    try {
      localStorage.removeItem(NOTIFICATION_SETTINGS_STORAGE_KEY);
      localStorage.removeItem(PUSH_PREFS_STORAGE_KEY);
      localStorage.removeItem(PUSH_USER_STORAGE_KEY);
    } catch {
      // no-op
    }

    setPushUserName('');
    setParentReceiveAll(true);
    setParentWatchChildren(['רביד', 'עמית', 'אלין']);
    setReminderLeadMinutes(defaultPushLeadMinutes);
    setPushSound(defaultPushSound);
    setSuccessMessage('ההגדרות אופסו בהצלחה.');
    if (apiError) {
      setApiError('');
    }
  };

  const handleDelete = async (
    payload: {
      eventId: string;
      recurringTemplateId?: string;
      sourceEvent?: SchedulerEvent;
      sourceDayIndex?: number;
    },
    targetWeekStart: Date,
    afterDeleteApi?: () => void,
  ): Promise<boolean> => {
    console.log('Action triggered:', 'delete');
    const deletePassword = await requestDeletePassword();
    if (!deletePassword) {
      return false;
    }

    setDbSyncStatus({ state: 'saving', message: 'מוחק...' });
    const trimmedEventId = payload.eventId.trim();
    const trimmedTemplateId = payload.recurringTemplateId?.trim();
    try {
      await deleteEventFromDatabase(
        { eventId: trimmedEventId, recurringTemplateId: trimmedTemplateId },
        deletePassword,
      );

      void fetch(toApiUrl('/api/state'), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: trimmedEventId || undefined,
          recurringTemplateId: trimmedTemplateId || undefined,
        }),
      }).catch(() => {
        // Server snapshot cleanup is best-effort; schedule DB is authoritative.
      });

      const src = payload.sourceEvent;
      const srcDay = payload.sourceDayIndex;
      let johnnySlotId: string | null = null;
      if (src && isJohnnyScheduleTitle(src.title)) {
        const dayIdx =
          typeof srcDay === 'number' && srcDay >= 0 && srcDay <= 6
            ? srcDay
            : (parseEventDateKey(src.date)?.getDay() ?? 0);
        johnnySlotId = johnnyStableEventId(targetWeekStart, dayIdx, src.time);
        await upsertJohnnyTombstone(src, targetWeekStart, dayIdx);
      }

      afterDeleteApi?.();

      const targetWeekKey = toIsoDate(targetWeekStart);
      setWeeksData((prev) => {
        const tombstoneIds =
          johnnySlotId ? new Set<string>([johnnySlotId]) : undefined;
        const weekDays = prev[targetWeekKey]
          ? prev[targetWeekKey].map((day) => ({ ...day, events: [...day.events] }))
          : createWeekDays(targetWeekStart, false, recurringTemplates, {
              skipDefaultRecurringTemplates: true,
              johnnySuppressedIds: tombstoneIds,
            });

        const nextWeekDays = weekDays.map((day) => ({
          ...day,
          events: day.events.filter((event) => {
            if (trimmedTemplateId) {
              return event.recurringTemplateId !== trimmedTemplateId && event.id !== trimmedEventId;
            }
            if (johnnySlotId && (event.id === johnnySlotId || event.id === trimmedEventId)) {
              return false;
            }
            return event.id !== trimmedEventId;
          }),
        }));

        return { ...prev, [targetWeekKey]: nextWeekDays };
      });

      setDbSyncStatus({ state: 'idle', message: '' });
      void refetchEventsFromDatabase(targetWeekStart).catch((err) => {
        console.error('[API] refetch after delete failed', err);
      });
      return true;
    } catch (error) {
      console.error('[API] handleDelete failed', error);
      setDbSyncStatus({ state: 'error', message: 'מחיקה נכשלה' });
      throw error;
    }
  };

  const loadUpcomingList = useCallback(async () => {
    setUpcomingListLoading(true);
    setApiError('');
    try {
      const response = await fetch(toApiUrl('/api/schedule'), { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error || 'טעינת המשימות נכשלה');
      }
      const raw = (Array.isArray(payload?.events) ? payload.events : []) as ScheduleApiEvent[];
      const next = raw
        .filter((e) => e.title !== JOHNNY_SUPPRESSED_TITLE)
        .sort(compareScheduleApiEventsByDateTime);
      setUpcomingListEvents(next);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'טעינה נכשלה';
      setApiError(msg);
      setUpcomingListEvents([]);
    } finally {
      setUpcomingListLoading(false);
    }
  }, []);

  const deleteFromUpcomingList = useCallback(
    async (event: ScheduleApiEvent) => {
      const parsed = parseEventDateKey(event.date);
      if (!parsed) {
        return;
      }
      const ws = getWeekStart(parsed);
      const tid = event.recurringTemplateId?.trim();
      try {
        const ok = await handleDelete(
          { eventId: event.id.trim(), recurringTemplateId: tid || undefined },
          ws,
        );
        if (ok) {
          setSuccessMessage('המשימה נמחקה.');
          await loadUpcomingList();
        }
      } catch {
        // handleDelete / deleteEventFromDatabase מסמנים שגיאה
      }
    },
    [handleDelete, loadUpcomingList],
  );

  useEffect(() => {
    if (showUpcomingListModal) {
      void loadUpcomingList();
    }
  }, [showUpcomingListModal, loadUpcomingList]);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }

    console.log('[UI] auto refetch trigger', { weekKey, isHydrated });

    if (autoRefetchInFlightRef.current && autoRefetchWeekKeyRef.current === weekKey) {
      return;
    }

    autoRefetchInFlightRef.current = true;
    autoRefetchWeekKeyRef.current = weekKey;

    const targetWeekStart = new Date(`${weekKey}T00:00:00`);
    void refetchEventsFromDatabase(targetWeekStart)
      .catch((error) => {
        const message = error instanceof Error ? error.message : 'Failed to refetch events';
        setApiError(message);
      })
      .finally(() => {
        autoRefetchInFlightRef.current = false;
      });
  }, [weekKey, isHydrated]);

  useEffect(() => {
    if (!isHydrated || hasAutoScrolledToTodayRef.current) {
      return;
    }

    const today = new Date();
    const currentWeekKey = toIsoDate(getWeekStart(today));
    if (weekKey !== currentWeekKey) {
      return;
    }

    const targetDayCard = dayCardRefs.current[today.getDay()] ?? null;
    if (!targetDayCard) {
      return;
    }

    targetDayCard.scrollIntoView({ behavior: 'auto', block: 'start', inline: 'nearest' });
    hasAutoScrolledToTodayRef.current = true;
  }, [isHydrated, weekKey, days.length]);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const parseInstructionFallback = (text: string): { targetWeekStart: Date; events: AiEvent[] } | null => {
    const timeMatch = extractTimesFromLine(text)[0];
    const child = detectChildFromText(text);
    if (!timeMatch || !child) {
      return null;
    }

    const normalizedTime = normalizeLooseClock(timeMatch);
    if (!normalizedTime) {
      return null;
    }

    const today = new Date();
    const hasTodayKeyword = text.includes('היום');
    const explicitDayIndex = getDayIndexFromText(text);
    if (!hasTodayKeyword && explicitDayIndex === null) {
      return null;
    }

    const dayIndex = hasTodayKeyword ? today.getDay() : explicitDayIndex!;
    const targetDate = hasTodayKeyword ? today : getNextOccurrenceDate(dayIndex, today);
    const targetWeekStart = getWeekStart(targetDate);
    const { type, title } = detectTypeAndTitle(text);

    return {
      targetWeekStart,
      events: [{ dayIndex, date: toIsoDate(targetDate), time: normalizedTime, child, title, type }],
    };
  };

  const renderChildBadges = (childKey: ChildKey) => (
    <div className="flex flex-wrap items-center gap-1.5">
      {getChildKeys(childKey).map((baseKey) => {
        const config = baseChildrenConfig[baseKey];
        return (
          <span
            key={`${childKey}-${baseKey}`}
            className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-bold text-slate-700 shadow-sm"
          >
            <span className={`h-2.5 w-2.5 rounded-full ${config.color}`} />
            <span>{config.name}</span>
          </span>
        );
      })}
    </div>
  );

  const exportAsImage = async () => {
    if (exportImageBusy) {
      return;
    }

    setExportImageBusy(true);
    try {
      const outputWidth = 1080;
      const outputHeight = 1080;
      const padding = 36;
      const titleHeight = 80;
      const fileName = `family-schedule-${weekKey}.png`;

      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = outputWidth;
      exportCanvas.height = outputHeight;
      const context = exportCanvas.getContext('2d');
      if (!context) {
        setApiError('לא הצלחתי ליצור תמונה. נסי שוב.');
        return;
      }

      const canvasToBlob = async (canvas: HTMLCanvasElement) => {
        const fromBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png', 1));
        if (fromBlob) {
          return fromBlob;
        }

        const base64 = canvas.toDataURL('image/png');
        const res = await fetch(base64);
        return res.blob();
      };

      const downloadBlob = (blob: Blob) => {
        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 2000);
      };

      const shareOrDownload = async (blob: Blob) => {
        const file = new File([blob], fileName, { type: 'image/png' });
        const canUseNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
        let shared = false;

        if (canUseNativeShare) {
          try {
            const canShareFiles = typeof navigator.canShare === 'function'
              ? navigator.canShare({ files: [file] })
              : false;
            if (canShareFiles) {
              await navigator.share({
                title: 'לו״ז שבועי',
                text: `לו״ז שבועי ${weekRangeLabel}`,
                files: [file],
              });
              shared = true;
            }
          } catch {
            shared = false;
          }
        }

        if (shared) {
          setSuccessMessage('התמונה מוכנה לשיתוף בוואטסאפ.');
          return;
        }

        downloadBlob(blob);
        setSuccessMessage('התמונה נשמרה להורדה.');
      };

      const drawFallbackImage = () => {
        const drawRoundedRect = (x: number, y: number, width: number, height: number, radius: number) => {
          const r = Math.min(radius, width / 2, height / 2);
          context.beginPath();
          context.moveTo(x + r, y);
          context.lineTo(x + width - r, y);
          context.quadraticCurveTo(x + width, y, x + width, y + r);
          context.lineTo(x + width, y + height - r);
          context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
          context.lineTo(x + r, y + height);
          context.quadraticCurveTo(x, y + height, x, y + height - r);
          context.lineTo(x, y + r);
          context.quadraticCurveTo(x, y, x + r, y);
          context.closePath();
        };

        const truncate = (value: string, maxLen: number) => {
          if (value.length <= maxLen) {
            return value;
          }
          return `${value.slice(0, maxLen - 1)}…`;
        };

        const childColorHex: Record<BaseChildKey, string> = {
          ravid: '#3b82f6',
          amit: '#22c55e',
          alin: '#ec4899',
        };

        const dayAccent = ['#c7d2fe', '#bfdbfe', '#bbf7d0', '#fde68a', '#fecaca', '#ddd6fe', '#fbcfe8'];

        context.fillStyle = '#eef2ff';
        context.fillRect(0, 0, outputWidth, outputHeight);

        drawRoundedRect(padding, padding, outputWidth - (padding * 2), titleHeight, 20);
        context.fillStyle = '#1e293b';
        context.fill();

        context.fillStyle = '#ffffff';
        context.font = 'bold 36px Arial';
        context.textAlign = 'right';
        context.textBaseline = 'middle';
        context.fillText('לו״ז שבועי משפחתי', outputWidth - (padding + 24), padding + 30);

        context.fillStyle = '#cbd5e1';
        context.font = '22px Arial';
        context.fillText(weekRangeLabel, outputWidth - (padding + 24), padding + 62);

        const gridTop = padding + titleHeight + 16;
        const gridHeight = outputHeight - gridTop - padding;
        const columns = 3;
        const rows = 3;
        const gap = 16;
        const cardWidth = Math.floor((outputWidth - (padding * 2) - (gap * (columns - 1))) / columns);
        const cardHeight = Math.floor((gridHeight - (gap * (rows - 1))) / rows);

        days.slice(0, 7).forEach((day, index) => {
          const row = Math.floor(index / columns);
          const col = index % columns;
          const rtlCol = (columns - 1) - col;
          const isLastSingleCard = index === 6;
          const x = isLastSingleCard
            ? Math.floor((outputWidth - cardWidth) / 2)
            : padding + (rtlCol * (cardWidth + gap));
          const y = gridTop + (row * (cardHeight + gap));

          drawRoundedRect(x, y, cardWidth, cardHeight, 18);
          context.fillStyle = '#ffffff';
          context.fill();
          context.strokeStyle = '#cbd5e1';
          context.lineWidth = 2;
          context.stroke();

          drawRoundedRect(x + 2, y + 2, cardWidth - 4, 36, 14);
          context.fillStyle = dayAccent[index % dayAccent.length] || '#dbeafe';
          context.fill();

          context.fillStyle = '#0f172a';
          context.font = 'bold 24px Arial';
          context.textAlign = 'right';
          context.textBaseline = 'top';
          context.fillText(day.dayName, x + cardWidth - 14, y + 12);

          context.fillStyle = '#475569';
          context.font = '20px Arial';
          context.textAlign = 'left';
          context.fillText(day.date, x + 14, y + 14);

          const cardEvents = [...day.events]
            .sort((a, b) => a.time.localeCompare(b.time))
            .slice(0, 4);

          if (cardEvents.length === 0) {
            context.fillStyle = '#94a3b8';
            context.font = '20px Arial';
            context.textAlign = 'center';
            context.fillText('אין משימות', x + (cardWidth / 2), y + (cardHeight / 2));
            return;
          }

          let lineY = y + 50;
          cardEvents.forEach((event) => {
            const childKeys = getChildKeys(event.child);
            const childName = childKeys.map((key) => baseChildrenConfig[key].name).join(' + ');
            const eventLine = truncate(`${event.time}  ${event.title}`, 27);
            const childLine = truncate(childName, 26);

            drawRoundedRect(x + 8, lineY - 4, cardWidth - 16, 44, 10);
            context.fillStyle = '#f8fafc';
            context.fill();

            let dotX = x + 18;
            childKeys.forEach((childKey) => {
              context.beginPath();
              context.arc(dotX, lineY + 19, 5, 0, Math.PI * 2);
              context.fillStyle = childColorHex[childKey];
              context.fill();
              dotX += 14;
            });

            context.fillStyle = '#0f172a';
            context.font = 'bold 18px Arial';
            context.textAlign = 'right';
            context.fillText(eventLine, x + cardWidth - 12, lineY);

            lineY += 22;
            context.fillStyle = '#64748b';
            context.font = '16px Arial';
            context.fillText(childLine, x + cardWidth - 12, lineY);

            lineY += 22;
            context.strokeStyle = '#e2e8f0';
            context.lineWidth = 1;
            context.beginPath();
            context.moveTo(x + 12, lineY);
            context.lineTo(x + cardWidth - 12, lineY);
            context.stroke();
            lineY += 10;
          });
        });
      };

      const scheduleElement = document.getElementById('schedule-table');
      if (scheduleElement) {
        try {
          if (typeof document !== 'undefined' && 'fonts' in document) {
            await (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts?.ready;
          }

          const sourceCanvas = await html2canvas(scheduleElement, {
            backgroundColor: '#ffffff',
            scale: Math.max(2, Math.min(3, window.devicePixelRatio * 1.5)),
            useCORS: true,
            logging: false,
            ignoreElements: (element) => element.classList?.contains('capture-ignore') ?? false,
          });

          context.fillStyle = '#f8fafc';
          context.fillRect(0, 0, outputWidth, outputHeight);
          context.imageSmoothingEnabled = true;
          context.imageSmoothingQuality = 'high';

          context.fillStyle = '#1e293b';
          context.font = 'bold 40px Arial';
          context.textAlign = 'center';
          context.textBaseline = 'middle';
          context.fillText('לו״ז שבועי משפחתי', outputWidth / 2, padding + 22);

          const availableWidth = outputWidth - (padding * 2);
          const availableHeight = outputHeight - (padding * 2) - titleHeight;
          const scale = Math.min(availableWidth / sourceCanvas.width, availableHeight / sourceCanvas.height);
          const renderWidth = Math.floor(sourceCanvas.width * scale);
          const renderHeight = Math.floor(sourceCanvas.height * scale);
          const offsetX = Math.floor((outputWidth - renderWidth) / 2);
          const offsetY = padding + titleHeight + Math.floor((availableHeight - renderHeight) / 2);

          context.drawImage(sourceCanvas, offsetX, offsetY, renderWidth, renderHeight);
        } catch {
          drawFallbackImage();
        }
      } else {
        drawFallbackImage();
      }

      const blob = await canvasToBlob(exportCanvas);
      if (!blob) {
        setApiError('לא הצלחתי לשמור את התמונה. נסי שוב.');
        return;
      }

      await shareOrDownload(blob);

      if (apiError) {
        setApiError('');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'יצירת תמונה לוואטסאפ נכשלה';
      setApiError(message || 'יצירת תמונה לוואטסאפ נכשלה');
    } finally {
      setExportImageBusy(false);
    }
  };

  const shiftWeek = (offset: number) => {
    setWeekStart((prev) => addDays(prev, offset * 7));
  };

  const mutateSchedule = async (key: string, targetWeekStart: Date) => {
    if (key !== '/api/schedule') {
      return;
    }

    await refetchEventsFromDatabase(targetWeekStart);
  };

  const hardRefreshScheduleAfterSuccess = async (targetWeekStart: Date) => {
    await mutateSchedule('/api/schedule', targetWeekStart);
  };

  const handleClearAll = async () => {
    const confirmed = window.confirm('למחוק את כל המשימות מהלו״ז?');
    if (!confirmed) {
      return;
    }

    const deletePassword = await requestDeletePassword();
    if (!deletePassword) {
      return;
    }

    try {
      console.log('Action triggered:', 'delete');
      setDbSyncStatus({ state: 'saving', message: 'Clearing database...' });
      console.log('[API] DELETE /api/schedule -> start clearAll');
      const response = await fetch(toApiUrl('/api/schedule?clearAll=true'), {
        method: 'DELETE',
        headers: {
          'x-delete-password': deletePassword,
        },
      });
      const payload = await response.json();
      console.log('[API] DELETE /api/schedule ->', response.status, payload);
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to clear events');
      }

      setRecurringTemplates([]);
      setWeeksData({
        [weekKey]: createWeekDays(weekStart, false, [], { skipDefaultRecurringTemplates: true }),
      });

      await refetchEventsFromDatabase(weekStart);
      setDbSyncStatus({ state: 'saved', message: 'Cleared' });
    } catch (error) {
      console.error('[API] DELETE /api/schedule clearAll client failed', error);
      setDbSyncStatus({ state: 'error', message: 'Failed' });
      const msg = error instanceof Error ? error.message : '';
      if (msg.includes('Invalid delete password')) {
        setApiError('סיסמת המחיקה שגויה.');
      } else {
        setApiError(formatSchedulePersistenceError(error));
      }
      return;
    }
    setSuccessMessage('הנתונים נוקו. ניתן להתחיל הזנה מחדש ללא הכפילויות הישנות.');
    if (apiError) {
      setApiError('');
    }
  };

  const persistAiEventsToDatabase = async (events: AiEvent[], targetWeekStart: Date) => {
    setDbSyncStatus({ state: 'saving', message: 'Saving AI events...' });
    const resolvedTargetWeekStart = resolveTargetWeekStartFromEvents(events, targetWeekStart);
    await Promise.all(events.map(async (eventData) => {
      const normalizedChild = normalizeChildKey(String(eventData.child));
      if (!normalizedChild || eventData.dayIndex < 0 || eventData.dayIndex > 6) {
        return;
      }

      const parsedEventDate = eventData.date ? parseEventDateKey(eventData.date) : null;
      const resolvedEventDate = parsedEventDate ?? addDays(resolvedTargetWeekStart, eventData.dayIndex);
      const eventDate = toEventDateKey(resolvedEventDate);
      const recurringTemplateId = eventData.recurringWeekly ? generateId() : undefined;
      const event: SchedulerEvent = {
        id: generateId(),
        date: toApiDateString(eventDate, resolvedEventDate),
        time: normalizeTimeForPicker(eventData.time),
        child: normalizeChildForSave(normalizedChild),
        title: eventData.title,
        type: normalizeTypeForStorage(eventData.type, eventData.title),
        isRecurring: Boolean(eventData.recurringWeekly),
        recurringTemplateId,
        completed: false,
        sendNotification: true,
        requireConfirmation: false,
      };

      await upsertEventToDatabase(event, eventData.dayIndex);
    }));

    setWeekStart(resolvedTargetWeekStart);
    await refetchEventsFromDatabase(resolvedTargetWeekStart);
    setDbSyncStatus({ state: 'saved', message: 'Saved' });
  };

  const sendMessageNow = async (text: string, imageFile: File | null) => {
    if ((!text && !imageFile) || isSubmitting || requestInFlightRef.current) {
      return;
    }

    setApiError('');
    setSuccessMessage('');

    requestInFlightRef.current = true;
    setIsSubmitting(true);

    try {
      const now = Date.now();
      const minRequestGap = 900;
      const waitMs = Math.max(0, minRequestGap - (now - lastApiRequestAtRef.current));
      if (waitMs > 0) {
        await delay(waitMs);
      }
      lastApiRequestAtRef.current = Date.now();

      const headerChild = detectDefaultChildFromScheduleHeader(text);
      const localSchedule = parseComplexWhatsAppMessage(text, weekStart, headerChild);
      if (!imageFile && localSchedule && localSchedule.events.length > 0) {
        await persistAiEventsToDatabase(localSchedule.events, localSchedule.targetWeekStart);
        setSuccessMessage('האירועים נוספו מהטקסט (זיהוי מקומי).');
        setInputText('');
        setSelectedImage(null);
        await hardRefreshScheduleAfterSuccess(localSchedule.targetWeekStart);
        return;
      }

      const imagePart = imageFile ? await fileToGenerativePart(imageFile) : undefined;
      const outgoingText = text || 'נתח את התמונה והוסף אירועים ללו״ז';
      const response = await fetch(toApiUrl('/api/schedule'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: outgoingText,
          weekStart: weekKey,
          systemPrompt: AI_OCR_SYSTEM_PROMPT,
          model: PRIMARY_GEMINI_MODEL,
          fallbackModel: FALLBACK_GEMINI_MODEL,
          imagePart,
        }),
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error || 'שגיאה בעדכון הלו״ז');
      }

      const rawEvents = payload?.events ?? payload?.event ?? [];
      const events = (Array.isArray(rawEvents) ? rawEvents : [rawEvents]) as AiEvent[];
      if (events.length) {
        if (payload?.ok === true) {
          const targetWeekStart = resolveTargetWeekStartFromEvents(events, weekStart);
          setWeekStart(targetWeekStart);
          await hardRefreshScheduleAfterSuccess(targetWeekStart);
        } else {
          await persistAiEventsToDatabase(events, weekStart);
        }
        setSuccessMessage('האירועים נוספו בהצלחה ללו״ז.');
      } else {
        if (imageFile) {
          const fallbackEvents = getEnglishOcrFallbackEvents();
          await persistAiEventsToDatabase(fallbackEvents, weekStart);
          setSuccessMessage('אירועי האנגלית נוספו מהתמונה.');
        } else {
          setApiError('לא זוהו אירועים חדשים בטקסט. נסה ניסוח מפורט יותר.');
          return;
        }
      }

      setInputText('');
      setSelectedImage(null);
      await hardRefreshScheduleAfterSuccess(weekStart);
    } catch (error) {
      console.error('[API] POST /api/schedule client failed', error);
      const message = error instanceof Error ? error.message : 'לא הצלחתי לעדכן את הלו"ז';
      if (message.includes('429') || message.toLowerCase().includes('quota')) {
        setApiError('חריגה ממכסת Gemini (429). נסה שוב עוד מעט או כתוב ניסוח קצר וברור.');
      } else if ((message.includes('404') || message.toLowerCase().includes('not found')) && imageFile) {
        const fallbackEvents = getEnglishOcrFallbackEvents();
        await persistAiEventsToDatabase(fallbackEvents, weekStart);
        setSuccessMessage('אירועי האנגלית נוספו מהתמונה (fallback למודל נתמך).');
      } else if (message.includes('502') && imageFile) {
        const fallbackEvents = getEnglishOcrFallbackEvents();
        await persistAiEventsToDatabase(fallbackEvents, weekStart);
        setSuccessMessage('אירועי האנגלית נוספו מהתמונה (fallback).');
      } else {
        setApiError(message);
      }
    } finally {
      requestInFlightRef.current = false;
      setIsSubmitting(false);
    }
  };

  const handleSendMessage = () => {
    const text = inputText.trim();
    const imageFile = selectedImage;
    if ((!text && !imageFile) || isSubmitting || requestInFlightRef.current) {
      return;
    }

    void sendMessageNow(text, imageFile);
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (isSubmitting || requestInFlightRef.current) {
      return;
    }

    const file = event.target.files?.[0] || null;
    setSelectedImage(file);
    if (successMessage) {
      setSuccessMessage('');
    }
    if (apiError) {
      setApiError('');
    }
  };

  const openCreateEventModal = (dayIndex: number) => {
    const selectedDate = toIsoDate(addDays(weekStart, dayIndex));
    setCreatingEvent({
      selectedDate,
      recurringWeekly: false,
      data: {
        time: '08:00',
        child: 'amit',
        title: '',
        type: 'lesson',
        sendNotification: true,
        requireConfirmation: false,
        reminderLeadMinutes,
      },
    });
  };

  const saveCreatedEvent = async () => {
    console.log('Action triggered:', 'add');
    if (!creatingEvent) {
      console.warn('[UI] add aborted: creatingEvent is missing');
      return;
    }

    const title = creatingEvent.data.title.trim() || getDefaultTitleFromType(creatingEvent.data.type) || 'פעילות';
    if (!title) {
      console.warn('[UI] add aborted: missing title');
      setApiError('יש להזין כותרת למשימה לפני שמירה.');
      return;
    }

    const selectedDate = new Date(`${creatingEvent.selectedDate}T00:00:00`);
    if (Number.isNaN(selectedDate.getTime())) {
      console.warn('[UI] add aborted: invalid selectedDate', creatingEvent.selectedDate);
      setApiError('יש לבחור תאריך תקין לפני שמירה.');
      return;
    }

    const targetWeekStart = getWeekStart(selectedDate);
    const targetDayIndex = selectedDate.getDay();
    const recurringTemplateId = creatingEvent.recurringWeekly ? generateId() : undefined;
    const normalizedChild = normalizeChildForSave(creatingEvent.data.child);
    const eventToSave: SchedulerEvent = {
      id: generateId(),
      date: toApiDateString(selectedDate, selectedDate),
      time: normalizeTimeForPicker(creatingEvent.data.time),
      child: normalizedChild,
      title,
      type: normalizeTypeForStorage(creatingEvent.data.type || 'lesson', title),
      isRecurring: creatingEvent.recurringWeekly,
      recurringTemplateId,
      completed: false,
      sendNotification: Boolean(creatingEvent.data.sendNotification),
      requireConfirmation: Boolean(creatingEvent.data.requireConfirmation),
      reminderLeadMinutes: sanitizeReminderLead(creatingEvent.data.reminderLeadMinutes),
    };

    const targetWeekKey = toIsoDate(targetWeekStart);
    if (targetWeekKey !== weekKey) {
      setWeekStart(targetWeekStart);
    }

    try {
      console.log('[UI] add submit payload', { targetDayIndex, targetWeekStart: toIsoDate(targetWeekStart), eventToSave });
      await handleSubmit(eventToSave, targetDayIndex, targetWeekStart);
    } catch (error) {
      setApiError(formatSchedulePersistenceError(error));
      return;
    }

    setCreatingEvent(null);
    setSuccessMessage('המשימה נוספה בהצלחה ללו״ז.');
    if (apiError) {
      setApiError('');
    }
  };

  const saveEditedEvent = async () => {
    console.log('Action triggered:', 'edit');
    if (!editingEvent) {
      console.warn('[UI] edit aborted: editingEvent is missing');
      return;
    }

    if (editingEvent.data.completed) {
      setApiError('לא ניתן לערוך משימה שסומנה כבוצעה. ניתן ללחוץ על "בטל אישור".');
      return;
    }

    const trimmedTitle = editingEvent.data.title.trim() || getDefaultTitleFromType(editingEvent.data.type) || 'פעילות';
    if (!trimmedTitle) {
      console.warn('[UI] edit aborted: missing title');
      setApiError('יש להזין כותרת למשימה לפני שמירה.');
      return;
    }

    const selectedDate = new Date(`${editingEvent.selectedDate}T00:00:00`);
    if (Number.isNaN(selectedDate.getTime())) {
      console.warn('[UI] edit aborted: invalid selectedDate', editingEvent.selectedDate);
      setApiError('יש לבחור תאריך תקין לפני שמירה.');
      return;
    }

    const targetWeekStart = getWeekStart(selectedDate);
    const targetWeekKey = toIsoDate(targetWeekStart);
    const targetDayIndex = selectedDate.getDay();
    const normalizedChild = normalizeChildForSave(editingEvent.data.child);
    const updatedEvent: SchedulerEvent = {
      ...editingEvent.data,
      date: toApiDateString(selectedDate, selectedDate),
      child: normalizedChild,
      title: trimmedTitle,
      time: normalizeTimeForPicker(editingEvent.data.time),
      reminderLeadMinutes: sanitizeReminderLead(editingEvent.data.reminderLeadMinutes),
      isRecurring: editingEvent.recurringWeekly,
      recurringTemplateId: editingEvent.recurringWeekly
        ? (editingEvent.originalRecurringTemplateId ?? editingEvent.data.recurringTemplateId ?? generateId())
        : undefined,
    };

    if (targetWeekKey !== weekKey) {
      setWeekStart(targetWeekStart);
    }

    try {
      console.log('[UI] edit submit payload', { targetDayIndex, targetWeekStart: toIsoDate(targetWeekStart), updatedEvent });
      await handleSubmit(updatedEvent, targetDayIndex, targetWeekStart);
    } catch (error) {
      setApiError(formatSchedulePersistenceError(error));
      return;
    }

    setEditingEvent(null);
    setSuccessMessage('המשימה עודכנה בהצלחה.');
    if (apiError) {
      setApiError('');
    }
  };

  const undoCompletedEvent = async () => {
    if (!editingEvent) {
      return;
    }

    const selectedDate = new Date(`${editingEvent.selectedDate}T00:00:00`);
    const targetWeekStart = Number.isNaN(selectedDate.getTime()) ? weekStart : getWeekStart(selectedDate);

    setDbSyncStatus({ state: 'saving', message: 'Updating completion...' });
    try {
      await setEventCompletionInDatabase(editingEvent.data.id, false);
      await refetchEventsFromDatabase(targetWeekStart);
      setEditingEvent((prev) => prev ? ({ ...prev, data: { ...prev.data, completed: false } }) : prev);
      setDbSyncStatus({ state: 'saved', message: 'Updated' });
      setSuccessMessage('אישור המשימה בוטל.');
    } catch {
      setDbSyncStatus({ state: 'error', message: 'Failed' });
      setApiError('עדכון סטטוס משימה נכשל. נסה שוב.');
    }
  };

  const deleteEditedEvent = async () => {
    console.log('Action triggered:', 'delete');
    if (!editingEvent) {
      return;
    }

    const deletingEventId = editingEvent.data.id.trim();
    const existingTemplateId = (editingEvent.originalRecurringTemplateId ?? editingEvent.data.recurringTemplateId)?.trim();
    const selectedDate = new Date(`${editingEvent.selectedDate}T00:00:00`);
    const deleteTargetWeekStart = Number.isNaN(selectedDate.getTime()) ? weekStart : getWeekStart(selectedDate);

    try {
      const deleted = await handleDelete(
        {
          eventId: deletingEventId,
          recurringTemplateId: existingTemplateId,
          sourceEvent: editingEvent.data,
          sourceDayIndex: editingEvent.dayIndex,
        },
        deleteTargetWeekStart,
        () => {
          setEditingEvent(null);
          setDbSyncStatus({ state: 'idle', message: '' });
        },
      );
      if (!deleted) {
        return;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : '';
      if (msg.includes('Invalid delete password')) {
        setApiError('סיסמת המחיקה שגויה.');
      } else {
        setApiError('מחיקה מבסיס הנתונים נכשלה. נסה שוב.');
      }
      return;
    }

    setSuccessMessage('המשימה נמחקה מהלו״ז.');
  };

  return (
    <div className="print-scheduler-shell h-screen overflow-y-auto bg-[#f8fafc] px-3 pt-12 pb-20 md:px-4 md:pt-14 md:pb-24 dir-rtl" dir="rtl">
      <button
        type="button"
        onClick={() => setShowSettingsModal(true)}
        className="fixed top-5 left-5 md:top-6 md:left-6 z-40 h-10 w-10 rounded-full bg-slate-800 text-white shadow-lg hover:bg-slate-700 transition print:hidden flex items-center justify-center"
        aria-label="פתח הגדרות"
      >
        <Settings size={18} />
      </button>
      <button
        type="button"
        onClick={() => setShowUpcomingListModal(true)}
        className="fixed top-[5.5rem] left-5 md:left-6 z-40 h-10 w-10 rounded-full bg-indigo-600 text-white shadow-lg hover:bg-indigo-700 transition print:hidden flex items-center justify-center"
        aria-label="כל המשימות מהמסד"
      >
        <ClipboardList size={18} />
      </button>
      <button
        type="button"
        onClick={() => { void handleManualRefresh(); }}
        disabled={isRefreshing}
        className="fixed top-5 right-5 md:top-6 md:right-6 z-40 h-9 rounded-full bg-white border border-slate-200 text-slate-700 shadow-lg hover:bg-slate-50 transition print:hidden flex items-center justify-center gap-1.5 px-3 disabled:opacity-60 disabled:cursor-not-allowed"
        aria-label="רענן"
      >
        <RefreshCw size={14} className={isRefreshing ? 'animate-spin' : ''} />
        <span className="text-xs font-bold">רענן</span>
      </button>
      <div className="fixed top-5 left-1/2 -translate-x-1/2 z-40 rounded-full border border-indigo-300 bg-indigo-100 px-3 py-1 text-xs font-extrabold text-indigo-900 shadow-lg print:hidden">
        גרסה חדשה פעילה • V20
      </div>

      <div className="max-w-6xl mx-auto mb-4 pb-4 print:hidden">
        {pendingReminderConfirmation && (
          <div className="mb-3 rounded-xl border border-indigo-200 bg-indigo-50 p-3 flex items-center justify-between gap-3">
            <div className="text-sm text-indigo-900 font-semibold">
              התקבלה תזכורת למשימה. לחצו לאישור צפייה.
            </div>
            <button
              type="button"
              onClick={() => { void confirmReminderSeen(); }}
              disabled={confirmingReminderSeen}
              className="shrink-0 rounded-lg bg-indigo-600 text-white px-3 py-1.5 text-sm font-semibold hover:bg-indigo-700 transition disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {confirmingReminderSeen ? 'שולח אישור...' : 'אישרתי שראיתי'}
            </button>
          </div>
        )}
        <div className="relative flex items-center justify-center">
        <button
          onClick={() => shiftWeek(1)}
          className="absolute right-0 h-9 w-9 rounded-full bg-white border border-slate-200 shadow-sm hover:bg-slate-50 text-slate-700 transition flex items-center justify-center"
          aria-label="שבוע הבא"
        >
          <ChevronRight size={18} />
        </button>
        <div className="w-[80%] rounded-full bg-white border border-slate-200 shadow-sm px-6 py-3 text-center text-slate-800 font-extrabold text-xl tracking-tight">
          {weekRangeLabel}
        </div>
        <button
          onClick={() => shiftWeek(-1)}
          className="absolute left-0 h-9 w-9 rounded-full bg-white border border-slate-200 shadow-sm hover:bg-slate-50 text-slate-700 transition flex items-center justify-center"
          aria-label="שבוע קודם"
        >
          <ChevronLeft size={18} />
        </button>
        </div>
      </div>

      <div className="max-w-6xl mx-auto mb-2 bg-white border border-slate-200 rounded-2xl p-2 shadow-sm print:hidden space-y-2">
        <div className="rounded-2xl bg-white border border-slate-200 p-2.5 shadow-sm flex flex-wrap items-center justify-center gap-2">
          {(Object.keys(baseChildrenConfig) as BaseChildKey[]).map((childKey) => {
            const config = baseChildrenConfig[childKey];
            return (
              <div key={childKey} className="flex items-center gap-1.5 bg-white border border-slate-200 rounded-xl px-3 py-2 shadow-sm hover:bg-slate-50 transition">
                <span className={`w-3 h-3 rounded-full ${config.color}`} />
                <span className="text-sm font-bold text-slate-700">{config.name}</span>
              </div>
            );
          })}
        </div>

      </div>

      <div className="max-w-6xl mx-auto mb-4 print:hidden">
        <h2 className="text-base font-bold text-slate-700">לו״ז שבועי</h2>
      </div>

      {showScheduleLoading ? (
        <div className="max-w-6xl mx-auto py-16 flex flex-col items-center justify-center gap-2 text-slate-600 print:hidden">
          <RefreshCw size={22} className="animate-spin text-indigo-600" aria-hidden />
          <span className="text-sm font-semibold">טוען לו״ז מהשרת…</span>
        </div>
      ) : (
      <div id="schedule-table" className="printable-schedule max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {days.map((day, dayIndex) => {
          const currentCellDate = toEventDateKey(new Date(`${day.isoDate}T00:00:00`));
          const visibleEvents = day.events.filter((event) => {
            const isRecurringEvent = Boolean(event.isRecurring);
            const matchesChild = activeChildFilter === 'all' || getChildKeys(event.child).includes(activeChildFilter);
            if (!matchesChild) {
              return false;
            }
            if (isRecurringEvent) {
              return true;
            }
              return normalizeEventDateKey(event.date, new Date(`${day.isoDate}T00:00:00`)) === currentCellDate;
          });

          return (
          <div
            key={day.isoDate}
            ref={(element) => {
              dayCardRefs.current[dayIndex] = element;
            }}
            className="bg-white rounded-3xl shadow-xl overflow-hidden border border-slate-100 ring-1 ring-slate-200 print-day-card flex flex-col min-h-[280px]"
          >
            <div className="bg-[#1e293b] text-white p-4 flex justify-between items-center shrink-0">
              <span className="font-bold text-lg">{day.dayName}</span>
              <span className="text-sm font-mono opacity-70">{day.date}</span>
            </div>

            <div className="flex flex-col flex-1 min-h-0 print-day-content">
            <div
              className="p-4 space-y-3 min-h-[120px] max-h-[min(70vh,720px)] overflow-y-auto print-day-content"
              onClick={(event) => {
                if (event.target === event.currentTarget) {
                  openCreateEventModal(dayIndex);
                }
              }}
            >
              {visibleEvents.length === 0 && (
                <button
                  type="button"
                  onClick={() => openCreateEventModal(dayIndex)}
                  className="w-full text-sm text-slate-500 border border-dashed border-slate-300 rounded-2xl p-3 text-center hover:bg-slate-50 transition capture-ignore print-edit"
                >
                  אין אירועים כרגע — לחץ להוספת משימה
                </button>
              )}
              {visibleEvents.map((event) => {
                const mainIconColor = baseChildrenConfig[getChildKeys(event.child)[0]].iconColor;
                const eventLink = typeof event.zoomLink === 'string' ? event.zoomLink.trim() : '';
                return (
                  <div
                    key={event.id}
                    onClick={(clickEvent) => {
                      const target = clickEvent.target as HTMLElement;
                      if (target.closest('[data-confirm-button="1"]') || target.closest('[data-link-button="1"]')) {
                        return;
                      }

                      setEditingEvent({
                        sourceWeekKey: weekKey,
                        dayIndex,
                        selectedDate: day.isoDate,
                        data: { ...event, time: normalizeTimeForPicker(event.time) },
                        recurringWeekly: Boolean(event.isRecurring),
                        originalRecurringTemplateId: event.recurringTemplateId,
                      });
                    }}
                    className="w-full text-right flex items-center justify-between p-3 rounded-2xl bg-slate-50 border border-transparent hover:border-slate-200 transition print:pointer-events-none print-event-item"
                  >
                    <span className="text-slate-500 font-medium text-sm w-14">{event.time}</span>
                    <div className="flex-1 min-w-0 flex items-start gap-3">
                      {renderChildBadges(event.child)}
                      <div className="min-w-0 flex-1 space-y-2">
                        <div className="flex items-center gap-2 flex-wrap min-w-0">
                          {event.completed && (
                            <span className={`${statusPillClassName} text-emerald-700 bg-emerald-50 border-emerald-200`}>בוצע</span>
                          )}
                          <span className="text-slate-700 font-semibold text-sm break-words whitespace-pre-wrap max-w-full">{event.title}</span>
                          {event.sendNotification !== false && (
                            <span className={`${statusPillClassName} text-indigo-700 bg-indigo-50 border-indigo-200`}>התראה</span>
                          )}
                          {event.requireConfirmation && (
                            <span className={`${statusPillClassName} text-amber-700 bg-amber-50 border-amber-200`}>אישור ילד</span>
                          )}
                          {event.isRecurring && (
                            <span className={`${statusPillClassName} text-blue-700 bg-blue-50 border-blue-200`}>קבוע</span>
                          )}
                          {event.requireConfirmation && !event.completed && (
                            <button
                              type="button"
                              data-confirm-button="1"
                              onClick={(buttonEvent) => {
                                buttonEvent.stopPropagation();
                                void confirmEventFromBoard(event);
                              }}
                              disabled={confirmingEventId === event.id}
                              className="rounded-lg bg-indigo-600 text-white px-2.5 py-1 text-xs font-semibold hover:bg-indigo-700 transition disabled:opacity-60 disabled:cursor-not-allowed"
                            >
                              {confirmingEventId === event.id ? 'שולח אישור...' : 'אישרתי שראיתי'}
                            </button>
                          )}
                        </div>
                        {eventLink && (
                          <a
                            href={eventLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            data-link-button="1"
                            onClick={(linkEvent) => {
                              linkEvent.stopPropagation();
                            }}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 text-white px-3 py-1.5 text-xs font-semibold hover:bg-blue-700 transition max-w-full"
                          >
                            <Video size={14} />
                            פתח Zoom
                          </a>
                        )}
                      </div>
                    </div>
                    <div className={mainIconColor}>
                      {getEventIcon(event.type, event.title)}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="px-4 pb-4 pt-2 shrink-0 border-t border-slate-100 bg-white">
              <button
                type="button"
                onClick={() => openCreateEventModal(dayIndex)}
                className="w-full flex items-center justify-center gap-2 text-sm text-slate-600 border border-dashed border-slate-300 rounded-2xl p-2.5 hover:bg-slate-50 transition print:hidden capture-ignore print-edit"
              >
                <Plus size={16} /> הוסף משימה
              </button>
            </div>
            </div>
          </div>
        )})}
      </div>
      )}

      {showUpcomingListModal && (
        <div className="fixed inset-0 z-[60] bg-black/35 backdrop-blur-[1px] flex items-start sm:items-center justify-center p-3 pt-6 print:hidden">
          <div className="w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col bg-white rounded-2xl shadow-2xl border border-slate-200">
            <div className="shrink-0 flex justify-between items-center border-b border-slate-200 px-4 py-3 gap-2">
              <div>
                <h3 className="text-lg font-bold text-slate-800">כל המשימות (מהמסד)</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  רשימה מלאה לפי מסד הנתונים — עבר, היום ועתיד, לסידור ומחיקה. ממוין לפי תאריך ושעה.
                </p>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => { void loadUpcomingList(); }}
                  disabled={upcomingListLoading}
                  className="h-9 px-2 rounded-lg text-slate-600 hover:bg-slate-100 text-xs font-bold disabled:opacity-50"
                >
                  רענון
                </button>
                <button
                  type="button"
                  onClick={() => setShowUpcomingListModal(false)}
                  className="h-8 w-8 rounded-full bg-slate-100 text-slate-700 hover:bg-slate-200 flex items-center justify-center"
                  aria-label="סגור"
                >
                  <X size={18} />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-3 min-h-0">
              {upcomingListLoading ? (
                <div className="flex flex-col items-center justify-center py-16 gap-2 text-slate-500">
                  <RefreshCw size={22} className="animate-spin text-indigo-600" />
                  <span className="text-sm font-semibold">טוען...</span>
                </div>
              ) : upcomingListEvents.length === 0 ? (
                <p className="text-center text-slate-500 py-12 text-sm">אין משימות במסד (או שהרשימה ריקה).</p>
              ) : (
                <ul className="space-y-2">
                  {upcomingListEvents.map((ev) => {
                    const childKey = normalizeChildKey(String(ev.child));
                    const childName = childKey ? baseChildrenConfig[childKey].name : String(ev.child);
                    const now = new Date();
                    const past = isEventStartInPast(ev, now);
                    return (
                      <li
                        key={ev.id}
                        className={`flex items-start gap-2 rounded-xl border p-3 text-right ${
                          ev.completed
                            ? 'border-slate-200 bg-slate-100/90 opacity-80'
                            : past
                              ? 'border-slate-200 bg-slate-50/80'
                              : 'border-emerald-200 bg-emerald-50/40'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => { void deleteFromUpcomingList(ev); }}
                          disabled={dbSyncStatus.state === 'saving'}
                          className="shrink-0 mt-0.5 h-9 w-9 rounded-lg border border-red-200 bg-white text-red-600 hover:bg-red-50 flex items-center justify-center disabled:opacity-50"
                          title="מחק משימה"
                          aria-label={`מחק ${ev.title}`}
                        >
                          <Trash2 size={16} />
                        </button>
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2 justify-end">
                            <span className="text-sm font-extrabold text-slate-900 break-words">{ev.title}</span>
                            {ev.completed && (
                              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border border-emerald-200 bg-emerald-50 text-emerald-800">בוצע</span>
                            )}
                            {!ev.completed && past && (
                              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border border-slate-300 bg-white text-slate-600">עבר</span>
                            )}
                            {!ev.completed && !past && (
                              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border border-emerald-200 bg-white text-emerald-800">עתידי</span>
                            )}
                            {ev.isRecurring && (
                              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border border-blue-200 bg-blue-50 text-blue-800">קבוע</span>
                            )}
                          </div>
                          <div className="text-xs text-slate-600 mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 justify-end">
                            <span className="font-semibold">{formatUpcomingListDayLabel(ev.date)}</span>
                            <span>·</span>
                            <span>{normalizeTimeForPicker(ev.time)}</span>
                            <span>·</span>
                            <span className={`inline-flex items-center gap-1 ${childKey ? baseChildrenConfig[childKey].iconColor : 'text-slate-600'}`}>
                              <span className={`h-2 w-2 rounded-full ${childKey ? baseChildrenConfig[childKey].color : 'bg-slate-400'}`} />
                              {childName}
                            </span>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <div className="shrink-0 border-t border-slate-100 px-4 py-2.5 bg-slate-50 rounded-b-2xl">
              <p className="text-[11px] text-slate-500 text-center">
                מחיקה: לחיצה על הפח פותחת אישור סיסמת מחיקה (כמו בלוח השבועי).
              </p>
            </div>
          </div>
        </div>
      )}

      {showSettingsModal && (
        <div className="fixed inset-0 z-50 bg-black/35 backdrop-blur-[1px] flex items-start sm:items-center justify-center p-3 pt-6 print:hidden">
          <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto bg-white rounded-2xl shadow-2xl border border-slate-200 p-4 space-y-3">
            <div className="sticky top-0 z-10 bg-white flex justify-between items-center border-b border-slate-200 pb-2">
              <h3 className="text-lg font-bold text-slate-800">הגדרות</h3>
              <button
                type="button"
                onClick={() => setShowSettingsModal(false)}
                className="h-8 w-8 rounded-full bg-slate-100 text-slate-700 hover:bg-slate-200 flex items-center justify-center"
                aria-label="סגור"
              >
                <X size={18} />
              </button>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700 space-y-2 leading-relaxed">
              <div className="font-bold text-slate-800">עריכת הלו״ז</div>
              <p>
                <span className="font-semibold text-slate-800">הוספת משימה:</span>{' '}
                בתחתית כל יום יש כפתור &quot;+ הוסף משימה&quot; (נשאר גלוי גם כשיש הרבה אירועים). אפשר גם ללחוץ על הרקע הריק כשאין אירועים ביום.
              </p>
              <p>
                <span className="font-semibold text-slate-800">מחיקת משימה:</span>{' '}
                לחיצה על משימה פותחת עריכה — בחרי &quot;מחק משימה&quot; בשורת הפעולות למטה, ואז הזיני את סיסמת המחיקה (ברירת מחדל <span className="font-mono">2101</span>, או הערך של <code className="text-xs bg-white px-1 rounded border border-slate-200">DELETE_PASSWORD</code> בשרת).
              </p>
              <p>
                <span className="font-semibold text-slate-800">שמירה (פיתוח מקומי):</span>{' '}
                שמירת עריכות דורשת מסד Postgres. הוסיפי בקובץ <code className="text-xs bg-white px-1 rounded border border-slate-200">.env.local</code> את <code className="text-xs bg-white px-1 rounded border border-slate-200">SUPABASE_POSTGRES_URL</code> או <code className="text-xs bg-white px-1 rounded border border-slate-200">SUPABASE_DATABASE_URL</code> (עדיפות), או <code className="text-xs bg-white px-1 rounded border border-slate-200">POSTGRES_URL</code> / <code className="text-xs bg-white px-1 rounded border border-slate-200">DATABASE_URL</code>, שמרי והפעילי מחדש את <span className="font-mono text-xs">npm run dev</span>.
              </p>
            </div>

            <div className="space-y-1.5">
              {isInstallReady && (
                <button
                  type="button"
                  onClick={() => { void installApp(); }}
                  className="w-full flex items-center justify-center gap-2 bg-amber-50 text-amber-800 border border-amber-200 px-4 py-1.5 rounded-lg hover:bg-amber-100 transition"
                >
                  התקן אפליקציה
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setShowSettingsModal(false);
                  void openPushIdentityPrompt();
                }}
                disabled={pushBusy}
                className="w-full flex items-center justify-center gap-2 bg-blue-50 text-blue-700 border border-blue-200 px-4 py-1.5 rounded-lg hover:bg-blue-100 transition disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {pushEnabled
                  ? `משתמש במכשיר: ${pushUserName || 'לא נבחר'}`
                  : (pushBusy ? 'מפעיל התראות...' : 'הפעל התראות')}
              </button>
              <button
                type="button"
                onClick={() => { void sendTestPushNotification(); }}
                disabled={pushBusy || pushTestBusy}
                className="w-full flex items-center justify-center gap-2 bg-indigo-50 text-indigo-700 border border-indigo-200 px-4 py-1.5 rounded-lg hover:bg-indigo-100 transition disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {pushTestBusy ? 'שולח התראה...' : 'שלח התראת ניסיון'}
              </button>
              <button
                type="button"
                onClick={() => { void sendDirectTestPushToSelectedChild(); }}
                disabled={pushRavidTestBusy || !selectedChildForDirectTest}
                className="w-full flex items-center justify-center gap-2 bg-indigo-50 text-indigo-700 border border-indigo-200 px-4 py-1.5 rounded-lg hover:bg-indigo-100 transition disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {pushRavidTestBusy
                  ? `שולח ל${selectedChildForDirectTest || 'ילד'}...`
                  : `שלח בדיקה ל${selectedChildForDirectTest || 'ילד נבחר'}`}
              </button>
              <button
                type="button"
                onClick={() => { void handleClearAll(); }}
                className="w-full flex items-center justify-center gap-2 bg-red-50 text-red-700 border border-red-200 px-4 py-1.5 rounded-lg hover:bg-red-100 transition"
              >
                Clear All
              </button>
              <button
                type="button"
                onClick={() => window.print()}
                className="w-full flex items-center justify-center gap-2 bg-white border border-slate-200 px-4 py-1.5 rounded-lg hover:bg-slate-50 transition"
              >
                <Printer size={18} /> הדפסה
              </button>
              <button
                type="button"
                onClick={() => { void exportAsImage(); }}
                disabled={exportImageBusy}
                className="w-full flex items-center justify-center gap-2 bg-slate-800 text-white px-4 py-1.5 rounded-lg hover:bg-slate-700 transition disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <ImageIcon size={18} /> {exportImageBusy ? 'מכין תמונה...' : 'תמונה לוואטסאפ'}
              </button>
              {pushUserName && (
                <div className="text-xs text-slate-600 bg-slate-100 border border-slate-200 rounded-lg px-2 py-2 text-center">
                  פרופיל התראות: {pushUserName}
                </div>
              )}
            </div>

            {canViewPresencePanel && (
              <div className="space-y-2 border border-slate-200 rounded-xl p-2.5 bg-slate-50">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-bold text-slate-700">מי רשום ומי פעיל</div>
                <button
                  type="button"
                  onClick={() => { void refreshPresenceUsers(); }}
                  disabled={presenceBusy}
                  className="text-[11px] rounded-lg border border-slate-300 bg-white px-2 py-1 text-slate-600 hover:bg-slate-50 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {presenceBusy ? 'טוען...' : 'רענן סטטוס'}
                </button>
              </div>

              {presenceUsers.filter((user) => user.registered).length === 0 ? (
                <div className="text-xs text-slate-500">אין משתמשים רשומים כרגע.</div>
              ) : (
                <div className="space-y-1.5">
                  {presenceUsers
                    .filter((user) => user.registered)
                    .map((user) => (
                      <div key={`presence-${user.userName}`} className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-2.5 py-2">
                        <div className="text-sm font-semibold text-slate-700">{user.userName}</div>
                        <div className="flex flex-col items-end gap-0.5">
                          <div className={`text-[11px] font-bold ${user.hasSubscription ? 'text-indigo-600' : 'text-rose-600'}`}>
                            {user.hasSubscription ? 'פוש פעיל' : 'ללא פוש פעיל'}
                          </div>
                          <div className={`text-xs font-bold ${user.isOnline ? 'text-emerald-600' : 'text-slate-500'}`}>
                            {formatPresenceLastSeen(user.lastSeen, user.isOnline)}
                          </div>
                        </div>
                      </div>
                    ))}
                </div>
              )}
                </div>
              )}

            {notificationsApproved && (
              <div className="space-y-2 border border-slate-200 rounded-xl p-2.5 bg-slate-50">
                <div>
                  <div className="text-xs text-slate-500 mb-1">בחירת צליל</div>
                  <select
                    value={pushSound}
                    onChange={(event) => setPushSound(sanitizePushSound(event.target.value))}
                    className="w-full rounded-xl border border-slate-300 px-3 py-1.5 text-sm text-slate-700 outline-none focus:border-blue-400"
                  >
                    {pushSoundOptions.map((option) => (
                      <option key={`settings-sound-${option.value}`} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <div className="text-xs text-slate-500 mb-1">זמן התראה</div>
                  <select
                    value={reminderLeadMinutes}
                    onChange={(event) => setReminderLeadMinutes(sanitizeReminderLead(event.target.value))}
                    className="w-full rounded-xl border border-slate-300 px-3 py-1.5 text-sm text-slate-700 outline-none focus:border-blue-400"
                  >
                    {reminderLeadOptions.map((minutes) => (
                      <option key={`settings-lead-${minutes}`} value={minutes}>{minutes} דקות לפני</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            <div className="space-y-2 border border-slate-200 rounded-xl p-2.5 bg-slate-50">
              <div className="text-xs font-bold text-slate-600">סינון תצוגה</div>
              <div>
                <div className="text-xs text-slate-500 mb-1">הצג משימות עבור</div>
                <select
                  value={settingsChildFilter}
                  onChange={(event) => setSettingsChildFilter(normalizeChildFilterValue(event.target.value))}
                  className="w-full rounded-xl border border-slate-300 px-3 py-1.5 text-sm text-slate-700 outline-none focus:border-blue-400"
                >
                  <option value="all">כולם</option>
                  {(Object.keys(baseChildrenConfig) as BaseChildKey[]).map((childKey) => (
                    <option key={`settings-filter-${childKey}`} value={childKey}>{baseChildrenConfig[childKey].name}</option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={saveSettingsChildFilter}
                className="w-full rounded-xl bg-blue-600 px-3 py-2 text-sm font-bold text-white hover:bg-blue-700 transition"
              >
                שמור
              </button>
            </div>

            <button
              type="button"
              onClick={resetSettingsWithPassword}
              className="w-full rounded-xl bg-rose-600 px-3 py-2 text-sm font-bold text-white hover:bg-rose-700 transition"
            >
              איפוס הגדרות (עם סיסמה)
            </button>
          </div>
        </div>
      )}

      {showPushIdentityPrompt && (
        <div className="fixed inset-0 z-50 bg-black/35 backdrop-blur-[1px] flex items-center justify-center p-4 print:hidden">
          <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-slate-200 p-5 space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-bold text-slate-800">מי משתמש במכשיר זה?</h3>
              {pushUserName && (
                <button
                  type="button"
                  onClick={() => {
                    setShowPushIdentityPrompt(false);
                    setHasConfirmedPushIdentitySelection(false);
                  }}
                  className="text-slate-500 hover:text-slate-700"
                  aria-label="סגור"
                >
                  <X size={18} />
                </button>
              )}
            </div>

            <p className="text-xs text-slate-500">יש לבחור שם משתמש למכשיר כדי שסטטוס הפעילות יעבוד בצורה מדויקת.</p>

            <div className="grid grid-cols-2 gap-2">
              {pushUserOptions.map((option) => (
                <button
                  key={`push-user-${option}`}
                  type="button"
                  onClick={() => selectPushUser(option)}
                  className={`rounded-xl border px-3 py-2 text-sm font-semibold transition ${pushUserName === option ? 'bg-blue-50 border-blue-400 text-blue-700' : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'}`}
                >
                  {option}
                </button>
              ))}
            </div>

            {isParentPushUser(pushUserName) && (
              <div className="space-y-3 border border-slate-200 rounded-xl p-3 bg-slate-50">
                <label className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                  <input
                    type="checkbox"
                    checked={parentReceiveAll}
                    onChange={(event) => setParentReceiveAll(event.target.checked)}
                  />
                  קבל/י את כל ההתראות של כל הילדים
                </label>

                {!parentReceiveAll && (
                  <div>
                    <div className="text-xs text-slate-500 mb-2">בחר/י ילדים למעקב:</div>
                    <div className="flex flex-wrap gap-2">
                      {pushChildOptions.map((child) => {
                        const checked = parentWatchChildren.includes(child);
                        return (
                          <button
                            key={`watch-${child}`}
                            type="button"
                            onClick={() => toggleParentTrackedChild(child)}
                            className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${checked ? 'bg-indigo-50 border-indigo-400 text-indigo-700' : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'}`}
                          >
                            {child}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowPushIdentityPrompt(false);
                  setHasConfirmedPushIdentitySelection(false);
                }}
                className="px-4 py-2 rounded-xl border border-slate-300 text-slate-700 hover:bg-slate-50 transition"
              >
                ביטול
              </button>
              <button
                type="button"
                onClick={() => { void confirmEnablePushNotifications(); }}
                className="px-4 py-2 rounded-xl bg-blue-600 text-white hover:bg-blue-700 transition"
              >
                {pushEnabled ? 'שמור פרופיל' : 'הפעל התראות'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="print-chat fixed bottom-5 right-5 z-40 print:hidden">
        {isChatOpen && (
          <div className="mb-3 w-[min(92vw,390px)] bg-white border border-slate-200 rounded-2xl shadow-2xl overflow-hidden">
            <div className="bg-slate-800 text-white px-4 py-3 flex items-center justify-between">
              <span className="text-sm font-semibold">עדכון חכם לצ׳אט</span>
              <button
                type="button"
                onClick={() => setIsChatOpen(false)}
                className="rounded-md bg-white/10 hover:bg-white/20 p-1 transition"
                aria-label="סגור צ׳אט"
              >
                <X size={16} />
              </button>
            </div>

            <div className="p-3">
              <div className="relative">
                <input
                  value={inputText}
                  disabled={isSubmitting || requestInFlightRef.current}
                  onChange={(e) => {
                    setInputText(e.target.value);
                    if (successMessage) {
                      setSuccessMessage('');
                    }
                  }}
                  type="text"
                  placeholder="עדכן לו״ז בקול חופשי (למשל: אימון לרביד ביום שלישי ב-16:00)"
                  className="w-full pl-14 pr-6 py-4 rounded-2xl border border-slate-200 bg-white shadow-sm focus:border-blue-400 focus:ring-0 outline-none transition-all text-right"
                />
                <button
                  type="button"
                  onClick={handleSendMessage}
                  disabled={isSubmitting || requestInFlightRef.current}
                  className="absolute left-2 top-2 bottom-2 bg-blue-600 text-white px-4 rounded-xl hover:bg-blue-700 transition flex items-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  <MessageCircle size={20} />
                  <span>{isSubmitting ? 'מעדכן...' : 'עדכן'}</span>
                </button>
              </div>

              <div className="mt-2 flex items-center justify-between gap-2">
                <label className="text-xs bg-white border border-slate-200 rounded-lg px-2 py-1 cursor-pointer hover:bg-slate-50">
                  העלאת תמונה
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    disabled={isSubmitting || requestInFlightRef.current}
                    onChange={handleFileUpload}
                  />
                </label>

                {selectedImage && (
                  <div className="flex items-center gap-2">
                    <div className="text-xs text-slate-700 bg-slate-100 border border-slate-200 rounded-md px-2 py-1 text-right">
                      תמונה נבחרה: {selectedImage.name}
                    </div>
                    {selectedImagePreview && (
                      <Image
                        src={selectedImagePreview}
                        alt="תצוגה מקדימה"
                        width={40}
                        height={40}
                        unoptimized
                        className="h-10 w-10 rounded-lg border border-slate-200 object-cover"
                      />
                    )}
                  </div>
                )}
              </div>

              {isSubmitting && <div className="text-slate-500 text-xs mt-2 text-right px-1">טוען...</div>}
              {successMessage && <div className="text-emerald-600 text-sm mt-2 text-right px-1">{successMessage}</div>}
              {apiError && <div className="text-red-500 text-sm mt-2 text-right px-1">{apiError}</div>}
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={() => setIsChatOpen((prev) => !prev)}
          className="h-14 w-14 rounded-full bg-slate-800 text-white shadow-xl hover:bg-slate-700 transition flex items-center justify-center"
          aria-label={isChatOpen ? 'סגור צ׳אט' : 'פתח צ׳אט'}
        >
          <MessageCircle size={24} />
        </button>
      </div>

      {creatingEvent && (
        <div className="fixed inset-0 bg-black/35 backdrop-blur-[1px] flex items-center justify-center p-4 z-[60] print:hidden">
          <div className="w-full max-w-lg max-h-[85vh] bg-white rounded-2xl shadow-2xl border border-slate-200 flex flex-col overflow-hidden">
            <div className="sticky top-0 z-10 bg-white border-b border-slate-200 px-5 py-4 flex justify-between items-center">
              <h2 className="text-lg font-bold text-slate-800">אירוע חדש</h2>
              <button
                type="button"
                onClick={() => setCreatingEvent(null)}
                className="text-slate-500 hover:text-slate-700"
              >
                <X size={20} />
              </button>
            </div>

            <div className="max-h-[70vh] overflow-y-auto p-5 space-y-4">

            {apiError && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 leading-relaxed">
                {apiError}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="text-sm text-slate-700 font-medium">
                תאריך
                <div className="relative mt-1">
                  <CalendarDays size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    type="date"
                    value={creatingEvent.selectedDate}
                    onChange={(e) => setCreatingEvent((prev) => prev ? ({ ...prev, selectedDate: e.target.value }) : prev)}
                    className="w-full border border-slate-300 rounded-xl pl-3 pr-9 py-2 outline-none focus:border-blue-400"
                  />
                </div>
              </label>

              <label className="text-sm text-slate-700 font-medium">
                ילד/ה
                <select
                  value={creatingEvent.data.child}
                  onChange={(e) => setCreatingEvent((prev) => prev ? ({ ...prev, data: { ...prev.data, child: e.target.value as ChildKey } }) : prev)}
                  className="mt-1 w-full border border-slate-300 rounded-xl px-3 py-2 outline-none focus:border-blue-400"
                >
                  {childOptions.map((option) => (
                    <option key={option.key} value={option.key}>{option.label}</option>
                  ))}
                </select>
                <div className="mt-2">{renderChildBadges(creatingEvent.data.child)}</div>
              </label>
            </div>

            <label className="text-sm text-slate-700 font-medium block">
              שעה
              <div className="mt-1 flex items-center gap-2">
                <select
                  value={getDropdownTimeValue(creatingEvent.data.time)}
                  onChange={(e) => setCreatingEvent((prev) => prev ? ({ ...prev, data: { ...prev.data, time: e.target.value || prev.data.time } }) : prev)}
                  className="flex-1 border border-slate-300 rounded-xl px-3 py-2 outline-none focus:border-blue-400"
                >
                  <option value="">בחר שעה</option>
                  {halfHourTimeOptions.map((timeOption) => (
                    <option key={`create-time-${timeOption}`} value={timeOption}>{timeOption}</option>
                  ))}
                </select>
                <input
                  value={creatingEvent.data.time}
                  onChange={(e) => setCreatingEvent((prev) => prev ? ({ ...prev, data: { ...prev.data, time: e.target.value } }) : prev)}
                  onBlur={(e) => {
                    const normalized = normalizeManualTimeInput(e.target.value);
                    setCreatingEvent((prev) => prev ? ({ ...prev, data: { ...prev.data, time: normalized } }) : prev);
                  }}
                  className="w-24 border border-slate-300 rounded-xl px-2 py-2 text-center outline-none focus:border-blue-400"
                  placeholder="14:25"
                />
              </div>
            </label>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="text-sm text-slate-700 font-medium">
                סוג פעילות
                <div className="mt-1 grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {activityTypePresets.map((preset) => {
                    const active = creatingEvent.data.type === preset.value;
                    return (
                      <button
                        key={`create-${preset.value}`}
                        type="button"
                        onClick={() => setCreatingEvent((prev) => prev ? ({ ...prev, data: { ...prev.data, type: preset.value } }) : prev)}
                        className={`rounded-xl border px-2 py-2 text-xs font-semibold transition ${active ? 'bg-blue-50 border-blue-400 text-blue-700' : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'}`}
                      >
                        <span className="text-base" aria-hidden="true">{preset.emoji}</span>
                        <span className="block mt-0.5">{preset.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <label className="text-sm text-slate-700 font-medium block">
              כותרת
              <input
                value={creatingEvent.data.title}
                onChange={(e) => setCreatingEvent((prev) => prev ? ({ ...prev, data: { ...prev.data, title: e.target.value } }) : prev)}
                className="mt-1 w-full border border-slate-300 rounded-xl px-3 py-2 outline-none focus:border-blue-400"
                placeholder="לדוגמה: שיעור קבוע - Karl"
              />
            </label>

            <label className="flex items-center gap-2 text-sm text-slate-700 font-medium">
              <input
                type="checkbox"
                checked={creatingEvent.recurringWeekly}
                onChange={(e) => setCreatingEvent((prev) => prev ? ({ ...prev, recurringWeekly: e.target.checked }) : prev)}
                className="h-4 w-4 rounded border-slate-300"
              />
              פעילות שבועית חוזרת
            </label>

            <div className="border border-slate-200 rounded-xl p-3 space-y-2 bg-slate-50">
              <div className="text-xs font-bold text-slate-600">הגדרות התראה</div>
              <label className="flex items-center gap-2 text-sm text-slate-700 font-medium">
                <input
                  type="checkbox"
                  checked={Boolean(creatingEvent.data.sendNotification)}
                  onChange={(e) => setCreatingEvent((prev) => prev ? ({ ...prev, data: { ...prev.data, sendNotification: e.target.checked } }) : prev)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                הפעל התראה למשימה זו
              </label>
              <div>
                <div className="text-xs text-slate-500 mb-1">מועד התראה למשימה זו</div>
                <select
                  value={creatingEvent.data.reminderLeadMinutes}
                  onChange={(e) => setCreatingEvent((prev) => prev ? ({
                    ...prev,
                    data: { ...prev.data, reminderLeadMinutes: sanitizeReminderLead(e.target.value) },
                  }) : prev)}
                  disabled={!creatingEvent.data.sendNotification}
                  className="w-full rounded-xl border border-slate-300 px-3 py-1.5 text-sm text-slate-700 outline-none focus:border-blue-400 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {reminderLeadOptions.map((minutes) => (
                    <option key={`create-event-lead-${minutes}`} value={minutes}>{minutes} דקות לפני</option>
                  ))}
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-700 font-medium">
                <input
                  type="checkbox"
                  checked={Boolean(creatingEvent.data.requireConfirmation)}
                  onChange={(e) => setCreatingEvent((prev) => prev ? ({ ...prev, data: { ...prev.data, requireConfirmation: e.target.checked } }) : prev)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                בקש אישור מהילד ושלח פוש להורים
              </label>
            </div>

            </div>

            <div className="sticky bottom-0 z-20 shrink-0 bg-white border-t border-slate-200 px-5 py-3 flex gap-2 justify-end">
              {dbSyncStatus.state !== 'idle' && (
                <div className={`self-center text-xs font-semibold ${dbSyncStatus.state === 'error' ? 'text-red-600' : dbSyncStatus.state === 'saving' ? 'text-amber-600' : 'text-emerald-600'}`}>
                  {dbSyncStatus.message}
                </div>
              )}
              <button
                type="button"
                onClick={() => setCreatingEvent(null)}
                className="px-4 py-2 rounded-xl border border-slate-300 text-slate-700 hover:bg-slate-100"
              >
                ביטול
              </button>
              <button
                type="button"
                onClick={() => { void saveCreatedEvent(); }}
                className="px-4 py-2 rounded-xl bg-blue-600 text-white hover:bg-blue-700"
              >
                הוסף
              </button>
            </div>
          </div>
        </div>
      )}

      {editingEvent && (
        <div className="fixed inset-0 bg-black/35 backdrop-blur-[1px] flex items-center justify-center p-4 z-[60] print:hidden">
          <div className="w-full max-w-lg max-h-[85vh] bg-white rounded-2xl shadow-2xl border border-slate-200 flex flex-col overflow-hidden">
            <div className="sticky top-0 z-10 bg-white border-b border-slate-200 px-5 py-4 flex justify-between items-center">
              <h2 className="text-lg font-bold text-slate-800">עריכת משימה</h2>
              <button
                type="button"
                onClick={() => setEditingEvent(null)}
                className="text-slate-500 hover:text-slate-700"
              >
                <X size={20} />
              </button>
            </div>

            <div className="max-h-[70vh] overflow-y-auto p-5 space-y-4">

            {apiError && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 leading-relaxed">
                {apiError}
              </div>
            )}

            {editingEvent.data.completed && (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700">
                המשימה סומנה כבוצעה — עריכה נעולה עד לביטול אישור.
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="text-sm text-slate-700 font-medium">
                תאריך
                <div className="relative mt-1">
                  <CalendarDays size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    type="date"
                    value={editingEvent.selectedDate}
                    onChange={(e) => setEditingEvent((prev) => prev ? ({ ...prev, selectedDate: e.target.value }) : prev)}
                    disabled={Boolean(editingEvent.data.completed)}
                    className="w-full border border-slate-300 rounded-xl pl-3 pr-9 py-2 outline-none focus:border-blue-400"
                  />
                </div>
              </label>

              <label className="text-sm text-slate-700 font-medium">
                ילד/ה
                <select
                  value={editingEvent.data.child}
                  onChange={(e) => setEditingEvent((prev) => prev ? ({ ...prev, data: { ...prev.data, child: e.target.value as ChildKey } }) : prev)}
                  disabled={Boolean(editingEvent.data.completed)}
                  className="mt-1 w-full border border-slate-300 rounded-xl px-3 py-2 outline-none focus:border-blue-400"
                >
                  {childOptions.map((option) => (
                    <option key={option.key} value={option.key}>{option.label}</option>
                  ))}
                </select>
                <div className="mt-2">{renderChildBadges(editingEvent.data.child)}</div>
              </label>
            </div>

            <label className="text-sm text-slate-700 font-medium block">
              שעה
              <div className="mt-1 flex items-center gap-2">
                <select
                  value={getDropdownTimeValue(editingEvent.data.time)}
                  onChange={(e) => setEditingEvent((prev) => prev ? ({ ...prev, data: { ...prev.data, time: e.target.value || prev.data.time } }) : prev)}
                  disabled={Boolean(editingEvent.data.completed)}
                  className="flex-1 border border-slate-300 rounded-xl px-3 py-2 outline-none focus:border-blue-400"
                >
                  <option value="">בחר שעה</option>
                  {halfHourTimeOptions.map((timeOption) => (
                    <option key={`edit-time-${timeOption}`} value={timeOption}>{timeOption}</option>
                  ))}
                </select>
                <input
                  value={editingEvent.data.time}
                  onChange={(e) => setEditingEvent((prev) => prev ? ({ ...prev, data: { ...prev.data, time: e.target.value } }) : prev)}
                  onBlur={(e) => {
                    const normalized = normalizeManualTimeInput(e.target.value);
                    setEditingEvent((prev) => prev ? ({ ...prev, data: { ...prev.data, time: normalized } }) : prev);
                  }}
                  disabled={Boolean(editingEvent.data.completed)}
                  className="w-24 border border-slate-300 rounded-xl px-2 py-2 text-center outline-none focus:border-blue-400"
                  placeholder="14:25"
                />
              </div>
            </label>

            <label className="text-sm text-slate-700 font-medium block">
              כותרת
              <input
                value={editingEvent.data.title}
                onChange={(e) => setEditingEvent((prev) => prev ? ({ ...prev, data: { ...prev.data, title: e.target.value } }) : prev)}
                disabled={Boolean(editingEvent.data.completed)}
                className="mt-1 w-full border border-slate-300 rounded-xl px-3 py-2 outline-none focus:border-blue-400"
              />
            </label>

            <label className="text-sm text-slate-700 font-medium block">
              סוג פעילות
              <input
                list="activity-types"
                value={editingEvent.data.type}
                onChange={(e) => setEditingEvent((prev) => prev ? ({ ...prev, data: { ...prev.data, type: e.target.value as EventType } }) : prev)}
                disabled={Boolean(editingEvent.data.completed)}
                className="mt-1 w-full border border-slate-300 rounded-xl px-3 py-2 outline-none focus:border-blue-400"
                placeholder="בחר או הקלד סוג פעילות"
              />
              <datalist id="activity-types">
                {eventTypeOptions.map((type) => (
                  <option key={type} value={type}>{eventTypeLabels[type]}</option>
                ))}
              </datalist>
            </label>

            <label className="flex items-center gap-2 text-sm text-slate-700 font-medium">
              <input
                type="checkbox"
                checked={editingEvent.recurringWeekly}
                onChange={(e) => setEditingEvent((prev) => prev ? ({ ...prev, recurringWeekly: e.target.checked }) : prev)}
                disabled={Boolean(editingEvent.data.completed)}
                className="h-4 w-4 rounded border-slate-300"
              />
              פעילות שבועית חוזרת
            </label>

            <div className="border border-slate-200 rounded-xl p-3 space-y-2 bg-slate-50">
              <div className="text-xs font-bold text-slate-600">הגדרות התראה</div>
              <label className="flex items-center gap-2 text-sm text-slate-700 font-medium">
                <input
                  type="checkbox"
                  checked={Boolean(editingEvent.data.sendNotification)}
                  onChange={(e) => setEditingEvent((prev) => prev ? ({ ...prev, data: { ...prev.data, sendNotification: e.target.checked } }) : prev)}
                  disabled={Boolean(editingEvent.data.completed)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                הפעל התראה למשימה זו
              </label>
              <div>
                <div className="text-xs text-slate-500 mb-1">מועד התראה למשימה זו</div>
                <select
                  value={sanitizeReminderLead(editingEvent.data.reminderLeadMinutes)}
                  onChange={(e) => setEditingEvent((prev) => prev ? ({
                    ...prev,
                    data: { ...prev.data, reminderLeadMinutes: sanitizeReminderLead(e.target.value) },
                  }) : prev)}
                  disabled={Boolean(editingEvent.data.completed) || !editingEvent.data.sendNotification}
                  className="w-full rounded-xl border border-slate-300 px-3 py-1.5 text-sm text-slate-700 outline-none focus:border-blue-400 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {reminderLeadOptions.map((minutes) => (
                    <option key={`edit-event-lead-${minutes}`} value={minutes}>{minutes} דקות לפני</option>
                  ))}
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-700 font-medium">
                <input
                  type="checkbox"
                  checked={Boolean(editingEvent.data.requireConfirmation)}
                  onChange={(e) => setEditingEvent((prev) => prev ? ({ ...prev, data: { ...prev.data, requireConfirmation: e.target.checked } }) : prev)}
                  disabled={Boolean(editingEvent.data.completed)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                בקש אישור מהילד ושלח פוש להורים
              </label>
            </div>

            {editingEvent.data.completed && (
              <button
                type="button"
                onClick={() => { void undoCompletedEvent(); }}
                className="w-full rounded-xl bg-emerald-600 text-white font-bold py-2.5 hover:bg-emerald-700 transition"
              >
                בטל אישור
              </button>
            )}

            </div>

            <div className="sticky bottom-0 z-20 shrink-0 bg-white border-t border-slate-200 px-5 py-3 flex flex-wrap items-center gap-2 justify-between">
              {dbSyncStatus.state !== 'idle' && (
                <div className={`text-xs font-semibold min-w-0 ${dbSyncStatus.state === 'error' ? 'text-red-600' : dbSyncStatus.state === 'saving' ? 'text-amber-600' : 'text-emerald-600'}`}>
                  {dbSyncStatus.message}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2 ms-auto justify-end">
                <button
                  type="button"
                  onClick={() => { void deleteEditedEvent(); }}
                  className="px-4 py-2 rounded-xl bg-red-600 text-white font-bold hover:bg-red-700 transition"
                >
                  מחק משימה
                </button>
                <button
                  type="button"
                  onClick={() => setEditingEvent(null)}
                  className="px-4 py-2 rounded-xl border border-slate-300 text-slate-700 hover:bg-slate-100"
                >
                  ביטול
                </button>
                <button
                  type="button"
                  onClick={() => { void saveEditedEvent(); }}
                  disabled={Boolean(editingEvent.data.completed)}
                  className="px-4 py-2 rounded-xl bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  שמירה
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {deletePasswordModalOpen && (
        <div
          className="fixed inset-0 z-[70] bg-black/45 backdrop-blur-[1px] flex items-center justify-center p-4 print:hidden"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-password-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              finishDeletePasswordModal(null);
            }
          }}
        >
          <div className="w-full max-w-sm bg-white rounded-2xl shadow-2xl border border-slate-200 p-5 space-y-4" dir="rtl">
            <h3 id="delete-password-title" className="text-lg font-bold text-slate-800">סיסמת מחיקה</h3>
            <p className="text-sm text-slate-600 leading-relaxed">
              הזיני את סיסמת המחיקה. ברירת המחדל בפיתוח היא <span className="font-mono font-semibold">2101</span> — אם הוגדרה בשרת משתנה <code className="text-xs bg-slate-100 px-1 rounded">DELETE_PASSWORD</code>, השתמשי בה.
            </p>
            <input
              type="password"
              autoComplete="off"
              autoFocus
              value={deletePasswordInput}
              onChange={(e) => setDeletePasswordInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  confirmDeletePasswordFromModal();
                }
                if (e.key === 'Escape') {
                  finishDeletePasswordModal(null);
                }
              }}
              className="w-full border border-slate-300 rounded-xl px-3 py-2.5 outline-none focus:border-blue-400 text-slate-900"
              placeholder="סיסמה"
            />
            <div className="flex gap-2 justify-end pt-1">
              <button
                type="button"
                onClick={() => finishDeletePasswordModal(null)}
                className="px-4 py-2 rounded-xl border border-slate-300 text-slate-700 hover:bg-slate-100"
              >
                ביטול
              </button>
              <button
                type="button"
                onClick={confirmDeletePasswordFromModal}
                className="px-4 py-2 rounded-xl bg-slate-800 text-white hover:bg-slate-700"
              >
                אישור
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}