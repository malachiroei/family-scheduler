"use client";
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { Dog, Dumbbell, Music, GraduationCap, Trophy, Printer, Image as ImageIcon, MessageCircle, ChevronRight, ChevronLeft, X, Plus, CalendarDays, Settings } from 'lucide-react';
import html2canvas from 'html2canvas';

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
  type: EventType;
  isRecurring?: boolean;
  recurringTemplateId?: string;
  completed?: boolean;
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
  type: EventType;
  isRecurring?: boolean;
};

type NewEventDraft = {
  selectedDate: string;
  recurringWeekly: boolean;
  data: {
    time: string;
    child: ChildKey;
    title: string;
    type: EventType;
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

const AI_OCR_SYSTEM_PROMPT = `אתה מנתח צילום מסך של אפליקציית שיעורים/מערכת שעות.
חלץ מהתמונה ומהטקסט אירועים בפורמט JSON בלבד (Array).
אם מופיעים תאריכים כמו 17/02/26 ושעות בטווח (למשל 14:30-14:55), השתמש בשעת ההתחלה.
אם מופיעים מורים Rachel או Karl, הוסף אותם לכותרת האירוע.
שיוך ילדים:
- עמית / Amit / Karl => child: "amit"
- אלין / Alin / Rachel => child: "alin"
- רביד / Ravid => child: "ravid"
מיפוי אייקון/סוג חכם:
- כל פעילות של כדורסל/משחק => type רצוי: "sport"
- כל פעילות של כושר/אימון (כולל "אימון מצוינות") => type רצוי: "gym"
- אם מזוהה שם פעילות ספציפי (למשל "אימון מצוינות") אפשר להחזיר type זהה לטקסט הפעילות כדי לאפשר ערך חופשי.
דוגמות לצילום מסך שיעורי אנגלית שיש להעדיף אם מזוהים:
- יום ה' (19/02): 14:00 שיעור קבוע עם Karl => dayIndex:4, time:"14:00", title:"שיעור קבוע - Karl", child:"amit", type:"lesson"
- יום ב' הבא (23/02): 15:00 שיעור קבוע עם Karl => dayIndex:1, time:"15:00", title:"שיעור קבוע - Karl", child:"amit", type:"lesson"
- יום ג' (24/02): 14:00 שיעור יחיד עם Rachel => dayIndex:2, time:"14:00", title:"שיעור יחיד - Rachel", child:"alin", type:"lesson"
אם הדוגמאות הללו מופיעות בתמונה, חלץ אותן בדיוק לערכים הללו.
החזר תמיד מערך אירועים בלבד.`;

const SCHEDULER_STORAGE_KEY = 'family-scheduler-state-v1';
const SCHEDULER_STATE_ENDPOINT = '/api/state';
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
  type: EventType;
  isRecurring?: boolean;
  recurringTemplateId?: string;
  completed?: boolean;
};

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

type PushUserName = 'רביד' | 'עמית' | 'אלין' | 'סיוון' | 'רועי';
type PushChildName = 'רביד' | 'עמית' | 'אלין';
type ReminderLeadMinutes = 5 | 10 | 15 | 30;
type PushSoundPreset = '/sounds/standard.mp3' | '/sounds/bell.mp3' | '/sounds/modern.mp3';

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
const SERVICE_WORKER_URL = '/sw.js?v=10';

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
              isRecurring: event.isRecurring ?? Boolean(event.recurringTemplateId),
              completed: Boolean(event.completed),
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
    const parsed = new Date(`${ddMmYyyy[3]}-${ddMmYyyy[2]}-${ddMmYyyy[1]}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const yyyyMmDd = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (yyyyMmDd) {
    const parsed = new Date(`${yyyyMmDd[1]}-${yyyyMmDd[2]}-${yyyyMmDd[3]}T00:00:00`);
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

const toDisplayDate = (date: Date) => {
  const d = `${date.getDate()}`.padStart(2, '0');
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  return `${d}.${m}`;
};

const generateId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const isTimeValue = (value: string) => /^(\d{2}):(\d{2})$/.test(value);

const normalizeTimeForPicker = (value: string) => {
  if (isTimeValue(value)) {
    return value;
  }
  return '08:00';
};

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
  if (/אימון/.test(text)) {
    return { type: 'gym', title: 'אימון' };
  }
  if (/(משחק|ספורט|כדורסל)/.test(text)) {
    return { type: 'sport', title: 'משחק/ספורט' };
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

const minutesFromClock = (value: string) => {
  const normalized = normalizeClock(value);
  if (!normalized) {
    return Number.MAX_SAFE_INTEGER;
  }
  const [hours, minutes] = normalized.split(':').map(Number);
  return hours * 60 + minutes;
};

const parseComplexWhatsAppMessage = (
  text: string,
  weekStart: Date
): { targetWeekStart: Date; events: AiEvent[] } | null => {
  if (!text.trim()) {
    return null;
  }

  const globalChild = detectChildFromText(text) || (/בית\s*דני/.test(text) ? 'amit' : null);
  const expandedText = text
    .replace(/(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)\s*[-:]/g, '\n$1 -')
    .replace(/(?:^|\s)(יום\s+[א-ת"׳']+)\s*[-:]/g, '\n$1 -');

  const lines = expandedText
    .split(/\r?\n|•|\u2022|\||;|,/)
    .map((line) => line.trim())
    .filter(Boolean);

  let currentDayIndex: number | null = null;
  const events: AiEvent[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const hasToday = line.includes('היום');
    const explicitDay = getDayIndexFromText(line);

    if (hasToday) {
      currentDayIndex = new Date().getDay();
    } else if (explicitDay !== null) {
      currentDayIndex = explicitDay;
    }

    if (currentDayIndex === null) {
      continue;
    }

    const timeMatches = extractTimesFromLine(line);
    const transportMatch = line.match(/(?:הסעה|יציאה|איסוף|אוספים)\s*(?:ב|בשעה)?\s*(\d{1,2}:\d{2}|\d{3,4}|\d{1,2})/);
    const transportTime = transportMatch ? normalizeLooseClock(transportMatch[1]) : null;

    const chosenTime =
      transportTime ||
      (timeMatches.length > 0
        ? [...timeMatches].sort((a, b) => minutesFromClock(a) - minutesFromClock(b))[0]
        : null);

    if (!chosenTime) {
      continue;
    }

    const inferredChild = detectChildFromText(line) || (/בית\s*דני/.test(line) ? 'amit' : null) || globalChild;
    if (!inferredChild) {
      continue;
    }

    const { type, title } = detectTypeAndTitle(line);
    const description = transportTime && transportTime !== chosenTime ? `${title} (כולל הסעה ${transportTime})` : title;

    const key = `${currentDayIndex}|${chosenTime}|${inferredChild}|${type}|${description}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    events.push({
      dayIndex: currentDayIndex,
      date: toIsoDate(hasToday ? new Date() : getNextOccurrenceDate(currentDayIndex, new Date())),
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
  { dayIndex: 4, time: '14:00', child: 'amit', title: 'שיעור קבוע - Karl', type: 'lesson' },
  { dayIndex: 1, time: '15:00', child: 'amit', title: 'שיעור קבוע - Karl', type: 'lesson' },
  { dayIndex: 2, time: '14:00', child: 'alin', title: 'שיעור יחיד - Rachel', type: 'lesson' },
];

const normalizePersistedState = (
  payload: PersistedStatePayload | null | undefined,
  fallbackWeekStart: Date
) => {
  const parsedWeekStart = payload?.weekStart ? new Date(payload.weekStart) : null;
  const safeWeekStart = parsedWeekStart && !Number.isNaN(parsedWeekStart.getTime())
    ? getWeekStart(parsedWeekStart)
    : fallbackWeekStart;

  const safeTemplates = Array.isArray(payload?.recurringTemplates) ? payload.recurringTemplates : [];
  const safeWeeksData = payload?.weeksData && typeof payload.weeksData === 'object'
    ? normalizeWeekEventsWithDate(payload.weeksData)
    : { [toIsoDate(safeWeekStart)]: createWeekDays(safeWeekStart, false, safeTemplates) };

  return {
    weekStart: safeWeekStart,
    recurringTemplates: safeTemplates,
    weeksData: safeWeeksData,
  };
};

const createEvent = (payload: Omit<SchedulerEvent, 'id'>): SchedulerEvent => ({
  id: generateId(),
  ...payload,
});

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

const getChildKeys = (key: ChildKey): BaseChildKey[] => {
  if (key === 'amit_alin') return ['amit', 'alin'];
  if (key === 'alin_ravid') return ['alin', 'ravid'];
  if (key === 'amit_ravid') return ['amit', 'ravid'];
  return [key];
};

const getSaturdayGroup = (weekStart: Date): ChildKey => {
  const reference = new Date('2026-02-15T00:00:00');
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const diffWeeks = Math.floor((getWeekStart(weekStart).getTime() - reference.getTime()) / weekMs);
  const cycle: ChildKey[] = ['amit_ravid', 'alin_ravid', 'amit_alin'];
  const index = ((diffWeeks % cycle.length) + cycle.length) % cycle.length;
  return cycle[index];
};

const buildJohnnyEvents = (weekStart: Date): Array<{ dayIndex: number; event: SchedulerEvent }> => {
  const saturdayGroup = getSaturdayGroup(weekStart);
  const dateForDay = (dayIndex: number) => toEventDateKey(addDays(weekStart, dayIndex));
  return [
    {
      dayIndex: 0,
      event: createEvent({ date: dateForDay(0), time: '08:00', child: 'amit', title: 'התור של ג׳וני (בוקר)', type: 'dog', isRecurring: true }),
    },
    {
      dayIndex: 0,
      event: createEvent({ date: dateForDay(0), time: '13:00', child: 'amit', title: 'התור של ג׳וני (צהריים)', type: 'dog', isRecurring: true }),
    },
    {
      dayIndex: 1,
      event: createEvent({ date: dateForDay(1), time: '08:00', child: 'alin', title: 'התור של ג׳וני (בוקר)', type: 'dog', isRecurring: true }),
    },
    {
      dayIndex: 1,
      event: createEvent({ date: dateForDay(1), time: '13:00', child: 'ravid', title: 'התור של ג׳וני (צהריים)', type: 'dog', isRecurring: true }),
    },
    {
      dayIndex: 2,
      event: createEvent({ date: dateForDay(2), time: '08:00', child: 'amit', title: 'התור של ג׳וני (בוקר)', type: 'dog', isRecurring: true }),
    },
    {
      dayIndex: 2,
      event: createEvent({ date: dateForDay(2), time: '13:00', child: 'amit', title: 'התור של ג׳וני (צהריים)', type: 'dog', isRecurring: true }),
    },
    {
      dayIndex: 3,
      event: createEvent({ date: dateForDay(3), time: '08:00', child: 'alin', title: 'התור של ג׳וני (בוקר)', type: 'dog', isRecurring: true }),
    },
    {
      dayIndex: 3,
      event: createEvent({ date: dateForDay(3), time: '13:00', child: 'ravid', title: 'התור של ג׳וני (צהריים)', type: 'dog', isRecurring: true }),
    },
    {
      dayIndex: 4,
      event: createEvent({ date: dateForDay(4), time: '08:00', child: 'amit', title: 'התור של ג׳וני (בוקר)', type: 'dog', isRecurring: true }),
    },
    {
      dayIndex: 4,
      event: createEvent({ date: dateForDay(4), time: '13:00', child: 'ravid', title: 'התור של ג׳וני (צהריים)', type: 'dog', isRecurring: true }),
    },
    {
      dayIndex: 5,
      event: createEvent({ date: dateForDay(5), time: '08:00', child: 'alin', title: 'התור של ג׳וני (בוקר)', type: 'dog', isRecurring: true }),
    },
    {
      dayIndex: 5,
      event: createEvent({ date: dateForDay(5), time: '13:00', child: 'ravid', title: 'התור של ג׳וני (צהריים)', type: 'dog', isRecurring: true }),
    },
    {
      dayIndex: 6,
      event: createEvent({ date: dateForDay(6), time: '13:00', child: saturdayGroup, title: 'הורדת ג׳וני', type: 'dog', isRecurring: true }),
    },
  ];
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

const createWeekDays = (weekStart: Date, includeDemo: boolean, recurringTemplates: RecurringTemplate[]): DaySchedule[] => {
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
      isRecurring: event.isRecurring ?? Boolean(event.recurringTemplateId),
      completed: Boolean(event.completed),
    });
  };

  buildJohnnyEvents(weekStart).forEach(({ dayIndex, event }) => addEvent(dayIndex, event));

  recurringTemplates
    .filter((template) => !template.title.includes('ג׳וני') && !template.title.includes("ג'וני"))
    .forEach((template) => {
    addEvent(template.dayIndex, {
      id: `${template.templateId}-${toIsoDate(weekStart)}`,
      date: toEventDateKey(addDays(weekStart, template.dayIndex)),
      time: template.time,
      child: template.child,
      title: template.title,
      type: template.type,
      isRecurring: template.isRecurring,
      recurringTemplateId: template.templateId,
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
  const [showRecurringOnly, setShowRecurringOnly] = useState(false);
  const [selectedChildFilter, setSelectedChildFilter] = useState<'all' | BaseChildKey>('all');
  const [weekStart, setWeekStart] = useState(initialWeekStart);
  const [recurringTemplates, setRecurringTemplates] = useState<RecurringTemplate[]>([]);
  const [weeksData, setWeeksData] = useState<Record<string, DaySchedule[]>>(() => ({
    [initialWeekKey]: createWeekDays(initialWeekStart, false, []),
  }));
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
  const [pushSupported, setPushSupported] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushTestBusy, setPushTestBusy] = useState(false);
  const [showPushIdentityPrompt, setShowPushIdentityPrompt] = useState(false);
  const [pushUserName, setPushUserName] = useState<PushUserName | ''>('');
  const [hasConfirmedPushIdentitySelection, setHasConfirmedPushIdentitySelection] = useState(false);
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

  const weekKey = toIsoDate(weekStart);
  const days = weeksData[weekKey] ?? [];
  const notificationsApproved = pushEnabled || (typeof Notification !== 'undefined' && Notification.permission === 'granted');

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
        [weekKey]: createWeekDays(weekStart, false, recurringTemplates),
      };
    });
  }, [weekKey, weekStart, recurringTemplates]);

  useEffect(() => {
    let cancelled = false;

    const hydrateState = async () => {
      try {
        const response = await fetch(SCHEDULER_STATE_ENDPOINT, { cache: 'no-store' });
        if (response.ok) {
          const payload = await response.json() as { state?: PersistedStatePayload };
          if (payload?.state && !cancelled) {
            const normalized = normalizePersistedState(payload.state, initialWeekStart);
            setWeekStart(initialWeekStart);
            setRecurringTemplates(normalized.recurringTemplates);
            setWeeksData({
              [toIsoDate(initialWeekStart)]: createWeekDays(initialWeekStart, false, normalized.recurringTemplates),
            });
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
          setWeekStart(initialWeekStart);
          setRecurringTemplates(normalized.recurringTemplates);
          setWeeksData({
            [toIsoDate(initialWeekStart)]: createWeekDays(initialWeekStart, false, normalized.recurringTemplates),
          });
        }
      } catch {
        if (!cancelled) {
          const fallbackWeek = initialWeekStart;
          setWeekStart(fallbackWeek);
          setRecurringTemplates([]);
          setWeeksData({
            [toIsoDate(fallbackWeek)]: createWeekDays(fallbackWeek, false, []),
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
      void fetch(SCHEDULER_STATE_ENDPOINT, {
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
      const data = event.data as { type?: string; payload?: { sound?: string; eventId?: string } } | undefined;

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
                await fetch('/api/push/subscribe', {
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

        const configResponse = await fetch('/api/push/subscribe', { cache: 'no-store' });
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
        return;
      }

      if (pushUserOptions.includes(savedUser as PushUserName)) {
        const user = savedUser as PushUserName;
        setPushUserName(user);
        if (isParentUserOption(user)) {
          setParentReceiveAll(true);
          setParentWatchChildren(['רביד', 'עמית', 'אלין']);
        }
      }
    } catch {
      // no-op
    }
  }, []);

  const openPushIdentityPrompt = () => {
    if (pushBusy) {
      return;
    }

    setApiError('');
    setHasConfirmedPushIdentitySelection(false);
    setShowPushIdentityPrompt(true);
  };

  const savePushSubscriptionProfile = async (serialized: PushSubscriptionJSON) => {
    const isParent = isParentPushUser(pushUserName);
    const receiveAll = isParent ? parentReceiveAll : false;
    const watchChildren = isParent && !receiveAll ? parentWatchChildren : [];

    const saveResponse = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: serialized,
        userName: pushUserName,
        receiveAll,
        watchChildren,
      }),
    });

    if (!saveResponse.ok) {
      const body = await saveResponse.json().catch(() => ({}));
      throw new Error(body?.error || 'Failed to save notification subscription');
    }
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
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          setApiError('לא אושרו התראות בדפדפן.');
          return;
        }

        const configResponse = await fetch('/api/push/subscribe', { cache: 'no-store' });
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
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setApiError('לא אושרו התראות בדפדפן.');
        return;
      }

      const registration = await ensureServiceWorkerRegistration();
      if (!registration) {
        setApiError('Service Worker לא זמין בדפדפן זה.');
        return;
      }

      const configResponse = await fetch('/api/push/subscribe', { cache: 'no-store' });
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

  const sendTestPushNotification = async () => {
    if (!pushEnabled || pushTestBusy) {
      return;
    }

    setPushTestBusy(true);
    try {
      const response = await fetch('/api/push/test', {
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

  const weekRangeLabel = `${toDisplayDate(weekStart)} - ${toDisplayDate(addDays(weekStart, 6))}`;

  const refetchEventsFromDatabase = async (targetWeekStart: Date) => {
    try {
      console.log('[API] GET /api/schedule -> start');
      const response = await fetch('/api/schedule', { cache: 'no-store' });
      const payload = await response.json();
      console.log('[API] GET /api/schedule ->', response.status, payload);
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed fetching events');
      }

      const allEvents = (Array.isArray(payload?.events) ? payload.events : []) as ScheduleApiEvent[];
      const recurringRows = allEvents.filter((event) => event.isRecurring);

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
          type: event.type,
          isRecurring: true,
        });
      }
    });

      const templates = [...templatesMap.values()];
      const targetWeekKey = toIsoDate(targetWeekStart);
      const weekDays = createWeekDays(targetWeekStart, false, templates).map((day) => ({ ...day, events: [...day.events] }));

      allEvents
      .filter((event) => !event.isRecurring)
      .forEach((event) => {
        const eventDate = parseEventDateKey(event.date);
        if (!eventDate) {
          return;
        }
        const eventWeekKey = toIsoDate(getWeekStart(eventDate));
        if (eventWeekKey !== targetWeekKey) {
          return;
        }
        const dayIndex = eventDate.getDay();
        weekDays[dayIndex].events.push({
          id: event.id,
          date: toEventDateKey(eventDate),
          time: normalizeTimeForPicker(event.time),
          child: event.child,
          title: event.title,
          type: event.type,
          isRecurring: false,
          recurringTemplateId: undefined,
          completed: Boolean(event.completed),
        });
        weekDays[dayIndex].events = sortEvents(weekDays[dayIndex].events);
      });

      setRecurringTemplates(templates);
      setWeeksData((prev) => ({ ...prev, [targetWeekKey]: weekDays }));
    } catch (error) {
      console.error('[API] GET /api/schedule client failed', error);
      throw error;
    }
  };

  const upsertEventToDatabase = async (event: SchedulerEvent, dayIndex: number) => {
    try {
      console.log('[API] POST /api/schedule -> start', event);
      const parsedEventDate = parseEventDateKey(event.date);
      const normalizedApiDate = parsedEventDate
        ? toIsoDate(parsedEventDate)
        : toIsoDate(getNextOccurrenceDate(dayIndex, new Date()));

      let response = await fetch('/api/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: {
            ...event,
            date: normalizedApiDate,
            dayIndex,
          },
        }),
      });

      if (!response.ok && (response.status === 404 || response.status === 405)) {
        response = await fetch('/api/schedule', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: {
              ...event,
              date: normalizedApiDate,
              dayIndex,
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

  const deleteEventFromDatabase = async (payload: { eventId: string; recurringTemplateId?: string }, deletePassword: string) => {
    try {
      console.log('[API] DELETE /api/schedule -> start', payload);
      const query = new URLSearchParams();
      if (payload.eventId) {
        query.set('id', payload.eventId);
      }
      if (payload.recurringTemplateId) {
        query.set('recurringTemplateId', payload.recurringTemplateId);
      }

      const response = await fetch(`/api/schedule?${query.toString()}`, {
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

    const response = await fetch('/api/schedule', {
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
    console.log('Action triggered:', 'add');
    setDbSyncStatus({ state: 'saving', message: 'Saving to database...' });
    try {
      await upsertEventToDatabase(event, dayIndex);
      await refetchEventsFromDatabase(targetWeekStart);

      setDbSyncStatus({ state: 'saved', message: 'Saved' });
    } catch (error) {
      console.error('[API] handleSubmit failed', error);
      setDbSyncStatus({ state: 'error', message: 'Failed' });
      throw error;
    }
  };

  const verifyDeletePassword = () => {
    const entered = window.prompt('הקלידי סיסמה למחיקה');
    if (entered === null) {
      return null;
    }

    const trimmed = entered.trim();
    if (trimmed !== '2101') {
      setApiError('סיסמה שגויה. המחיקה בוטלה.');
      return null;
    }

    return trimmed;
  };

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

  const handleDelete = async (payload: { eventId: string; recurringTemplateId?: string }, targetWeekStart: Date) => {
    console.log('Action triggered:', 'delete');
    const deletePassword = verifyDeletePassword();
    if (!deletePassword) {
      return;
    }

    setDbSyncStatus({ state: 'saving', message: 'Deleting from database...' });
    try {
      await deleteEventFromDatabase(payload, deletePassword);

      const targetWeekKey = toIsoDate(targetWeekStart);
      setWeeksData((prev) => {
        const weekDays = prev[targetWeekKey] ? prev[targetWeekKey].map((day) => ({ ...day, events: [...day.events] })) : createWeekDays(targetWeekStart, false, recurringTemplates);

        const nextWeekDays = weekDays.map((day) => ({
          ...day,
          events: day.events.filter((event) => {
            if (payload.recurringTemplateId) {
              return event.recurringTemplateId !== payload.recurringTemplateId && event.id !== payload.eventId;
            }
            return event.id !== payload.eventId;
          }),
        }));

        return { ...prev, [targetWeekKey]: nextWeekDays };
      });

      await refetchEventsFromDatabase(targetWeekStart);
      setDbSyncStatus({ state: 'saved', message: 'Deleted' });
    } catch (error) {
      console.error('[API] handleDelete failed', error);
      setDbSyncStatus({ state: 'error', message: 'Failed' });
      throw error;
    }
  };

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
    <div className="flex flex-wrap items-center gap-1">
      {getChildKeys(childKey).map((baseKey) => {
        const config = baseChildrenConfig[baseKey];
        return (
          <span key={`${childKey}-${baseKey}`} className={`px-4 py-1.5 rounded-full text-sm font-black uppercase tracking-tighter text-white ${config.color} shadow-sm`}>
            {config.name}
          </span>
        );
      })}
    </div>
  );

  const exportAsImage = async () => {
    const scheduleElement = document.getElementById('schedule-table');
    if (scheduleElement) {
      const sourceCanvas = await html2canvas(scheduleElement, {
        backgroundColor: '#ffffff',
        scale: Math.max(3, Math.min(4, window.devicePixelRatio * 2)),
        useCORS: true,
        logging: false,
        ignoreElements: (element) => element.classList?.contains('capture-ignore') ?? false,
      });

      const targetRatio = 16 / 9;
      let outputWidth = sourceCanvas.width;
      let outputHeight = Math.round(outputWidth / targetRatio);

      if (outputHeight < sourceCanvas.height) {
        outputHeight = sourceCanvas.height;
        outputWidth = Math.round(outputHeight * targetRatio);
      }

      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = outputWidth;
      exportCanvas.height = outputHeight;

      const context = exportCanvas.getContext('2d');
      if (!context) {
        return;
      }

      context.fillStyle = '#f8fafc';
      context.fillRect(0, 0, outputWidth, outputHeight);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';

      const offsetX = Math.round((outputWidth - sourceCanvas.width) / 2);
      const offsetY = Math.round((outputHeight - sourceCanvas.height) / 2);
      context.drawImage(sourceCanvas, offsetX, offsetY);

      const image = exportCanvas.toDataURL("image/png");
      const link = document.createElement('a');
      link.href = image;
      link.download = 'family-schedule.png';
      link.click();
    }
  };

  const shiftWeek = (offset: number) => {
    setWeekStart((prev) => addDays(prev, offset * 7));
  };

  const handleClearAll = async () => {
    const confirmed = window.confirm('למחוק את כל המשימות מהלו״ז?');
    if (!confirmed) {
      return;
    }

    const deletePassword = verifyDeletePassword();
    if (!deletePassword) {
      return;
    }

    try {
      console.log('Action triggered:', 'delete');
      setDbSyncStatus({ state: 'saving', message: 'Clearing database...' });
      console.log('[API] DELETE /api/schedule -> start clearAll');
      const response = await fetch('/api/schedule?clearAll=true', {
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
      setWeeksData((prev) => ({
        ...prev,
        [weekKey]: createWeekDays(weekStart, false, []),
      }));

      await refetchEventsFromDatabase(weekStart);
      setDbSyncStatus({ state: 'saved', message: 'Cleared' });
    } catch (error) {
      console.error('[API] DELETE /api/schedule clearAll client failed', error);
      setDbSyncStatus({ state: 'error', message: 'Failed' });
      setApiError('השמירה לבסיס הנתונים נכשלה. נסה שוב.');
      return;
    }
    setSuccessMessage('הנתונים נוקו. ניתן להתחיל הזנה מחדש ללא הכפילויות הישנות.');
    if (apiError) {
      setApiError('');
    }
  };

  const persistAiEventsToDatabase = async (events: AiEvent[], targetWeekStart: Date) => {
    setDbSyncStatus({ state: 'saving', message: 'Saving AI events...' });
    for (const eventData of events) {
      const normalizedChild = normalizeChildKey(String(eventData.child));
      if (!normalizedChild || eventData.dayIndex < 0 || eventData.dayIndex > 6) {
        continue;
      }

      const parsedEventDate = eventData.date ? parseEventDateKey(eventData.date) : null;
      const resolvedEventDate = parsedEventDate ?? addDays(targetWeekStart, eventData.dayIndex);
      const eventDate = toEventDateKey(resolvedEventDate);
      const recurringTemplateId = eventData.recurringWeekly ? generateId() : undefined;
      const event: SchedulerEvent = {
        id: generateId(),
        date: eventDate,
        time: normalizeTimeForPicker(eventData.time),
        child: normalizedChild,
        title: eventData.title,
        type: normalizeTypeForStorage(eventData.type, eventData.title),
        isRecurring: Boolean(eventData.recurringWeekly),
        recurringTemplateId,
        completed: false,
      };

      await upsertEventToDatabase(event, eventData.dayIndex);
    }

    await refetchEventsFromDatabase(targetWeekStart);
    setDbSyncStatus({ state: 'saved', message: 'Saved' });
  };

  const sendMessageNow = async (text: string, imageFile: File | null) => {
    if ((!text && !imageFile) || isSubmitting || requestInFlightRef.current) {
      return;
    }

    setApiError('');
    setSuccessMessage('');

    const parsedComplex = parseComplexWhatsAppMessage(text, weekStart);
    if (parsedComplex && !imageFile) {
      await persistAiEventsToDatabase(parsedComplex.events, parsedComplex.targetWeekStart);

      setInputText('');
      setSuccessMessage('האירועים נוספו בהצלחה ללו״ז.');
      return;
    }

    const parsedFallback = parseInstructionFallback(text);
    if (parsedFallback && !imageFile) {
      await persistAiEventsToDatabase(parsedFallback.events, parsedFallback.targetWeekStart);

      setInputText('');
      setSuccessMessage('האירוע נוסף בהצלחה ללו״ז.');
      return;
    }

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

      const imagePart = imageFile ? await fileToGenerativePart(imageFile) : undefined;
      const outgoingText = text || 'נתח את התמונה והוסף אירועים ללו״ז';
      const response = await fetch('/api/schedule', {
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
        await persistAiEventsToDatabase(events, weekStart);
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
    const eventToSave: SchedulerEvent = {
      id: generateId(),
      date: toEventDateKey(selectedDate),
      time: normalizeTimeForPicker(creatingEvent.data.time),
      child: creatingEvent.data.child,
      title,
      type: normalizeTypeForStorage(creatingEvent.data.type || 'lesson', title),
      isRecurring: creatingEvent.recurringWeekly,
      recurringTemplateId,
      completed: false,
    };

    const targetWeekKey = toIsoDate(targetWeekStart);
    if (targetWeekKey !== weekKey) {
      setWeekStart(targetWeekStart);
    }

    try {
      console.log('[UI] add submit payload', { targetDayIndex, targetWeekStart: toIsoDate(targetWeekStart), eventToSave });
      await handleSubmit(eventToSave, targetDayIndex, targetWeekStart);
    } catch {
      setApiError('שמירת העריכה לבסיס הנתונים נכשלה. נסה שוב.');
      return;
    }

    setCreatingEvent(null);
    setSuccessMessage('המשימה נוספה בהצלחה ללו״ז.');
    if (apiError) {
      setApiError('');
    }
  };

  const saveEditedEvent = async () => {
    console.log('Action triggered:', 'add');
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
    const updatedEvent: SchedulerEvent = {
      ...editingEvent.data,
      date: toEventDateKey(selectedDate),
      title: trimmedTitle,
      time: normalizeTimeForPicker(editingEvent.data.time),
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
    } catch {
      setApiError('ניקוי הנתונים בבסיס הנתונים נכשל. נסה שוב.');
      return;
    }

    setEditingEvent(null);
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

    const deletingEventId = editingEvent.data.id;
    const existingTemplateId = editingEvent.originalRecurringTemplateId;

    try {
      await handleDelete({ eventId: deletingEventId, recurringTemplateId: existingTemplateId }, weekStart);
    } catch {
      setApiError('מחיקה מבסיס הנתונים נכשלה. נסה שוב.');
      return;
    }

    setEditingEvent(null);
    setSuccessMessage('המשימה נמחקה מהלו״ז.');
  };

  return (
    <div className="print-scheduler-shell h-screen overflow-y-auto bg-[#f8fafc] p-3 pb-20 md:p-4 md:pb-24 dir-rtl" dir="rtl">
      <button
        type="button"
        onClick={() => setShowSettingsModal(true)}
        className="fixed top-2 left-2 md:top-3 md:left-3 z-40 h-10 w-10 rounded-full bg-slate-800 text-white shadow-lg hover:bg-slate-700 transition print:hidden flex items-center justify-center"
        aria-label="פתח הגדרות"
      >
        <Settings size={18} />
      </button>

      <div className="max-w-6xl mx-auto mb-2 flex items-center justify-between gap-2 bg-white border border-slate-200 rounded-2xl p-2 shadow-sm print:hidden">
        <button
          onClick={() => shiftWeek(1)}
          className="flex items-center gap-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 px-3 py-1.5 rounded-xl transition text-sm"
        >
          <ChevronRight size={18} /> שבוע הבא
        </button>
        <div className="text-slate-800 font-bold">{weekRangeLabel}</div>
        <button
          onClick={() => shiftWeek(-1)}
          className="flex items-center gap-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 px-3 py-1.5 rounded-xl transition text-sm"
        >
          שבוע קודם <ChevronLeft size={18} />
        </button>
      </div>

      <div className="max-w-6xl mx-auto mb-2 bg-white border border-slate-200 rounded-2xl p-2 shadow-sm print:hidden space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-semibold text-slate-500">תרשים:</span>
          {(Object.keys(baseChildrenConfig) as BaseChildKey[]).map((childKey) => {
            const config = baseChildrenConfig[childKey];
            return (
              <div key={childKey} className="flex items-center gap-1.5 bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1.5">
                <span className={`w-3 h-3 rounded-full ${config.color}`} />
                <span className="text-sm font-bold text-slate-700">{config.name}</span>
              </div>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-semibold text-slate-500">סינון לפי ילד:</span>
          <button
            type="button"
            onClick={() => setSelectedChildFilter('all')}
            className={`px-3 py-1 rounded-xl border text-sm font-semibold transition ${selectedChildFilter === 'all' ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'}`}
          >
            הכל
          </button>
          {(Object.keys(baseChildrenConfig) as BaseChildKey[]).map((childKey) => (
            <button
              key={`filter-${childKey}`}
              type="button"
              onClick={() => setSelectedChildFilter(childKey)}
              className={`px-3 py-1 rounded-xl border text-sm font-semibold transition ${selectedChildFilter === childKey ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'}`}
            >
              {baseChildrenConfig[childKey].name}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setShowRecurringOnly((prev) => !prev)}
            className={`px-3 py-1 rounded-xl border text-sm font-semibold transition ${showRecurringOnly ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'}`}
          >
            {showRecurringOnly ? 'מציג רק קבועים' : 'הצג רק קבועים'}
          </button>
        </div>
      </div>

      <div className="max-w-6xl mx-auto mb-1 print:hidden">
        <h2 className="text-base font-bold text-slate-700">Weekly View</h2>
      </div>

      <div id="schedule-table" className="printable-schedule max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {days.map((day, dayIndex) => {
          const currentCellDate = toEventDateKey(new Date(`${day.isoDate}T00:00:00`));
          const visibleEvents = day.events.filter((event) => {
            const isRecurringEvent = Boolean(event.isRecurring || event.recurringTemplateId);
            const matchesChild = selectedChildFilter === 'all' || getChildKeys(event.child).includes(selectedChildFilter);
            if (!matchesChild) {
              return false;
            }
            if (showRecurringOnly) {
              return isRecurringEvent;
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
            className="bg-white rounded-3xl shadow-xl overflow-hidden border border-slate-100 ring-1 ring-slate-200 print-day-card"
          >
            <div className="bg-[#1e293b] text-white p-4 flex justify-between items-center">
              <span className="font-bold text-lg">{day.dayName}</span>
              <span className="text-sm font-mono opacity-70">{day.date}</span>
            </div>

            <div
              className="p-4 space-y-3 min-h-[220px] print-day-content"
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
                return (
                  <button
                    key={event.id}
                    type="button"
                    onClick={() => setEditingEvent({
                      sourceWeekKey: weekKey,
                      dayIndex,
                      selectedDate: day.isoDate,
                      data: { ...event, time: normalizeTimeForPicker(event.time) },
                      recurringWeekly: Boolean(event.recurringTemplateId),
                      originalRecurringTemplateId: event.recurringTemplateId,
                    })}
                    className="w-full text-right flex items-center justify-between p-3 rounded-2xl bg-slate-50 border border-transparent hover:border-slate-200 transition print:pointer-events-none print-event-item"
                  >
                    <span className="text-slate-500 font-medium text-sm w-14">{event.time}</span>
                    <div className="flex-1 flex items-center gap-3">
                      {renderChildBadges(event.child)}
                      <div className="flex items-center gap-2">
                        {event.completed && (
                          <span className="text-[11px] font-bold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full">V</span>
                        )}
                        <span className="text-slate-700 font-semibold text-sm">{event.title}</span>
                        {(event.isRecurring || event.recurringTemplateId) && (
                          <span className="text-[10px] font-bold text-blue-700 bg-blue-100 px-2 py-0.5 rounded-full">קבוע</span>
                        )}
                      </div>
                    </div>
                    <div className={mainIconColor}>
                      {getEventIcon(event.type, event.title)}
                    </div>
                  </button>
                );
              })}

              <button
                type="button"
                onClick={() => openCreateEventModal(dayIndex)}
                className="w-full mt-1 flex items-center justify-center gap-2 text-sm text-slate-600 border border-dashed border-slate-300 rounded-2xl p-2.5 hover:bg-slate-50 transition print:hidden capture-ignore print-edit"
              >
                <Plus size={16} /> הוסף משימה
              </button>
            </div>
          </div>
        )})}
      </div>

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
                {pushEnabled ? 'התראות פעילות' : (pushBusy ? 'מפעיל התראות...' : 'הפעל התראות')}
              </button>
              <button
                type="button"
                onClick={() => { void sendTestPushNotification(); }}
                disabled={!pushEnabled || pushBusy || pushTestBusy}
                className="w-full flex items-center justify-center gap-2 bg-indigo-50 text-indigo-700 border border-indigo-200 px-4 py-1.5 rounded-lg hover:bg-indigo-100 transition disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {pushTestBusy ? 'שולח התראה...' : 'שלח התראת ניסיון'}
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
                onClick={exportAsImage}
                className="w-full flex items-center justify-center gap-2 bg-slate-800 text-white px-4 py-1.5 rounded-lg hover:bg-slate-700 transition"
              >
                <ImageIcon size={18} /> תמונה לוואטסאפ
              </button>
              {pushUserName && (
                <div className="text-xs text-slate-600 bg-slate-100 border border-slate-200 rounded-lg px-2 py-2 text-center">
                  פרופיל התראות: {pushUserName}
                </div>
              )}
            </div>

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
            </div>

            <p className="text-xs text-slate-500">יש לבחור שם לפני המשך הפעלת התראות.</p>

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
        <div className="fixed inset-0 bg-black/35 backdrop-blur-[1px] flex items-center justify-center p-4 z-50 print:hidden">
          <div className="w-full max-w-lg bg-white rounded-2xl shadow-2xl border border-slate-200 p-5 space-y-4">
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-bold text-slate-800">אירוע חדש</h2>
              <button
                type="button"
                onClick={() => setCreatingEvent(null)}
                className="text-slate-500 hover:text-slate-700"
              >
                <X size={20} />
              </button>
            </div>

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

            <div className="flex gap-2 justify-end pt-2">
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
        <div className="fixed inset-0 bg-black/35 backdrop-blur-[1px] flex items-center justify-center p-4 z-50 print:hidden">
          <div className="w-full max-w-lg bg-white rounded-2xl shadow-2xl border border-slate-200 p-5 space-y-4">
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-bold text-slate-800">עריכת משימה</h2>
              <button
                type="button"
                onClick={() => setEditingEvent(null)}
                className="text-slate-500 hover:text-slate-700"
              >
                <X size={20} />
              </button>
            </div>

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

            {editingEvent.data.completed && (
              <button
                type="button"
                onClick={() => { void undoCompletedEvent(); }}
                className="w-full rounded-xl bg-emerald-600 text-white font-bold py-2.5 hover:bg-emerald-700 transition"
              >
                בטל אישור
              </button>
            )}

            <button
              type="button"
              onClick={() => { void deleteEditedEvent(); }}
              className="w-full rounded-xl bg-red-600 text-white font-bold py-2.5 hover:bg-red-700 transition"
            >
              מחק משימה
            </button>

            <div className="flex gap-2 justify-end pt-2">
              {dbSyncStatus.state !== 'idle' && (
                <div className={`self-center text-xs font-semibold ${dbSyncStatus.state === 'error' ? 'text-red-600' : dbSyncStatus.state === 'saving' ? 'text-amber-600' : 'text-emerald-600'}`}>
                  {dbSyncStatus.message}
                </div>
              )}
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
      )}
    </div>
  );
}