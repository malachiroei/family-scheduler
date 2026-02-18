"use client";
import React, { useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { Dog, Dumbbell, Music, GraduationCap, Trophy, Printer, Image as ImageIcon, MessageCircle, ChevronRight, ChevronLeft, X, Plus, CalendarDays } from 'lucide-react';
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
  time: string;
  child: ChildKey;
  title: string;
  type: EventType;
  isRecurring?: boolean;
  recurringTemplateId?: string;
};

type DaySchedule = {
  date: string;
  dayName: string;
  isoDate: string;
  events: SchedulerEvent[];
};

type AiEvent = {
  dayIndex: number;
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
const FALLBACK_GEMINI_MODEL = 'gemini-2.0-flash';

type PersistedStatePayload = {
  weekStart?: string;
  recurringTemplates?: RecurringTemplate[];
  weeksData?: Record<string, DaySchedule[]>;
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

const toIsoDate = (date: Date) => {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  const d = `${date.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
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

const parseWeekKeyToDate = (value: string) => {
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return getWeekStart(parsed);
};

type TimeMeridiem = 'AM' | 'PM';

const toTwelveHourState = (value: string) => {
  const normalized = normalizeTimeForPicker(value);
  const [rawHour, rawMinute] = normalized.split(':').map(Number);
  const meridiem: TimeMeridiem = rawHour >= 12 ? 'PM' : 'AM';
  const hour12 = rawHour % 12 === 0 ? 12 : rawHour % 12;
  return { hour12, minute: rawMinute, meridiem };
};

const toTwentyFourHourClock = (hour12: number, minute: number, meridiem: TimeMeridiem) => {
  const normalizedHour = hour12 === 12 ? 0 : hour12;
  const hour24 = meridiem === 'PM' ? normalizedHour + 12 : normalizedHour;
  return `${`${hour24}`.padStart(2, '0')}:${`${minute}`.padStart(2, '0')}`;
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
      time: chosenTime,
      child: inferredChild,
      title: description,
      type,
    });
  }

  if (!events.length) {
    return null;
  }

  const targetWeekStart = text.includes('היום') ? getWeekStart(new Date()) : weekStart;
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
    ? payload.weeksData
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
  return [
    {
      dayIndex: 0,
      event: createEvent({ time: '08:00', child: 'amit', title: 'התור של ג׳וני (בוקר)', type: 'dog' }),
    },
    {
      dayIndex: 0,
      event: createEvent({ time: '13:00', child: 'amit', title: 'התור של ג׳וני (צהריים)', type: 'dog' }),
    },
    {
      dayIndex: 1,
      event: createEvent({ time: '08:00', child: 'alin', title: 'התור של ג׳וני (בוקר)', type: 'dog' }),
    },
    {
      dayIndex: 1,
      event: createEvent({ time: '13:00', child: 'ravid', title: 'התור של ג׳וני (צהריים)', type: 'dog' }),
    },
    {
      dayIndex: 2,
      event: createEvent({ time: '08:00', child: 'amit', title: 'התור של ג׳וני (בוקר)', type: 'dog' }),
    },
    {
      dayIndex: 2,
      event: createEvent({ time: '13:00', child: 'amit', title: 'התור של ג׳וני (צהריים)', type: 'dog' }),
    },
    {
      dayIndex: 3,
      event: createEvent({ time: '08:00', child: 'alin', title: 'התור של ג׳וני (בוקר)', type: 'dog' }),
    },
    {
      dayIndex: 3,
      event: createEvent({ time: '13:00', child: 'ravid', title: 'התור של ג׳וני (צהריים)', type: 'dog' }),
    },
    {
      dayIndex: 4,
      event: createEvent({ time: '08:00', child: 'amit', title: 'התור של ג׳וני (בוקר)', type: 'dog' }),
    },
    {
      dayIndex: 4,
      event: createEvent({ time: '13:00', child: 'ravid', title: 'התור של ג׳וני (צהריים)', type: 'dog' }),
    },
    {
      dayIndex: 5,
      event: createEvent({ time: '08:00', child: 'alin', title: 'התור של ג׳וני (בוקר)', type: 'dog' }),
    },
    {
      dayIndex: 5,
      event: createEvent({ time: '13:00', child: 'ravid', title: 'התור של ג׳וני (צהריים)', type: 'dog' }),
    },
    {
      dayIndex: 6,
      event: createEvent({ time: '13:00', child: saturdayGroup, title: 'הורדת ג׳וני', type: 'dog' }),
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
    days[dayIndex].events.push(event);
  };

  buildJohnnyEvents(weekStart).forEach(({ dayIndex, event }) => addEvent(dayIndex, event));

  recurringTemplates
    .filter((template) => !template.title.includes('ג׳וני') && !template.title.includes("ג'וני"))
    .forEach((template) => {
    addEvent(template.dayIndex, {
      id: `${template.templateId}-${toIsoDate(weekStart)}`,
      time: template.time,
      child: template.child,
      title: template.title,
      type: template.type,
      isRecurring: template.isRecurring,
      recurringTemplateId: template.templateId,
    });
    });

  if (includeDemo) {
    addEvent(0, createEvent({ time: '14:45', child: 'alin', title: 'תגבור פלא', type: 'lesson' }));
    addEvent(0, createEvent({ time: '17:30', child: 'ravid', title: 'אימון', type: 'gym' }));
    addEvent(0, createEvent({ time: '18:00', child: 'amit', title: 'כדורסל', type: 'sport' }));
    addEvent(1, createEvent({ time: '15:00', child: 'amit', title: 'אנגלית: עמית (קארל)', type: 'lesson' }));
    addEvent(1, createEvent({ time: '17:00', child: 'alin', title: 'ריקוד אלין', type: 'dance' }));
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

const TimeWheelPicker = ({ value, onChange }: { value: string; onChange: (next: string) => void }) => {
  const { hour12, minute, meridiem } = toTwelveHourState(value);
  const hourOptions = Array.from({ length: 12 }, (_, idx) => idx + 1);
  const minuteOptions = Array.from({ length: 60 }, (_, idx) => idx);
  const hourListRef = useRef<HTMLDivElement | null>(null);
  const minuteListRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const selectedHour = hourListRef.current?.querySelector<HTMLButtonElement>(`[data-hour="${hour12}"]`);
    selectedHour?.scrollIntoView({ block: 'center' });

    const selectedMinute = minuteListRef.current?.querySelector<HTMLButtonElement>(`[data-minute="${minute}"]`);
    selectedMinute?.scrollIntoView({ block: 'center' });
  }, [hour12, minute]);

  const updateHour = (nextHour: number) => onChange(toTwentyFourHourClock(nextHour, minute, meridiem));
  const updateMinute = (nextMinute: number) => onChange(toTwentyFourHourClock(hour12, nextMinute, meridiem));
  const updateMeridiem = (nextMeridiem: TimeMeridiem) => onChange(toTwentyFourHourClock(hour12, minute, nextMeridiem));

  return (
    <div className="mt-1 rounded-xl border border-slate-300 p-3 bg-white">
      <div className="grid grid-cols-3 gap-3 items-start">
        <div>
          <div className="text-xs text-slate-500 mb-1 text-center">שעה</div>
          <div ref={hourListRef} className="h-36 overflow-y-auto rounded-lg border border-slate-200 p-1">
            {hourOptions.map((option) => (
              <button
                key={`hour-${option}`}
                data-hour={option}
                type="button"
                onClick={() => updateHour(option)}
                className={`w-full rounded-md px-2 py-1.5 text-sm font-semibold transition ${hour12 === option ? 'bg-blue-600 text-white' : 'text-slate-700 hover:bg-slate-100'}`}
              >
                {`${option}`.padStart(2, '0')}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="text-xs text-slate-500 mb-1 text-center">דקות</div>
          <div ref={minuteListRef} className="h-36 overflow-y-auto rounded-lg border border-slate-200 p-1">
            {minuteOptions.map((option) => (
              <button
                key={`minute-${option}`}
                data-minute={option}
                type="button"
                onClick={() => updateMinute(option)}
                className={`w-full rounded-md px-2 py-1.5 text-sm font-semibold transition ${minute === option ? 'bg-blue-600 text-white' : 'text-slate-700 hover:bg-slate-100'}`}
              >
                {`${option}`.padStart(2, '0')}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="text-xs text-slate-500 mb-1 text-center">AM / PM</div>
          <div className="flex flex-col gap-2">
            {(['AM', 'PM'] as const).map((period) => (
              <button
                key={period}
                type="button"
                onClick={() => updateMeridiem(period)}
                className={`h-[68px] rounded-xl text-base font-extrabold transition ${meridiem === period ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}
              >
                {period}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
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
  const [showRecurringOnly, setShowRecurringOnly] = useState(false);
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
  const persistDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestInFlightRef = useRef(false);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const lastApiRequestAtRef = useRef<number>(0);
  const hasLoadedStorageRef = useRef(false);

  const weekKey = toIsoDate(weekStart);
  const days = weeksData[weekKey] ?? [];
  const hasGeminiKey = Boolean(process.env.NEXT_PUBLIC_GEMINI_API_KEY);

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
            [toIsoDate(fallbackWeek)]: createWeekDays(fallbackWeek, false, []),
          });
        }
      }
    };

    void hydrateState().finally(() => {
      if (!cancelled) {
        hasLoadedStorageRef.current = true;
      }
    });

    return () => {
      cancelled = true;
    };
  }, [initialWeekStart]);

  useEffect(() => {
    if (!hasLoadedStorageRef.current) {
      return;
    }

    const payload = {
      weekStart: weekStart.toISOString(),
      recurringTemplates,
      weeksData,
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
  }, [weekStart, recurringTemplates, weeksData]);

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

  const weekRangeLabel = `${toDisplayDate(weekStart)} - ${toDisplayDate(addDays(weekStart, 6))}`;

  const addSingleEventToDays = (baseDays: DaySchedule[], eventData: AiEvent) => {
    const nextDays = baseDays.map((day) => ({ ...day, events: [...day.events] }));

    if (eventData.dayIndex < 0 || eventData.dayIndex > 6) {
      return nextDays;
    }

    const normalizedTime = normalizeTimeForPicker(eventData.time);
    const normalizedChild = normalizeChildKey(String(eventData.child));
    if (!normalizedChild) {
      return nextDays;
    }

    const eventType = normalizeTypeForStorage(String(eventData.type || ''), String(eventData.title || ''));

    const hasDuplicate = nextDays[eventData.dayIndex].events.some((existing) => {
      if (existing.time !== normalizedTime || existing.type !== eventType) {
        return false;
      }
      return getChildKeys(existing.child).includes(normalizedChild);
    });

    if (hasDuplicate) {
      return nextDays;
    }

    nextDays[eventData.dayIndex].events.push(createEvent({
      time: normalizedTime,
      child: normalizedChild,
      title: eventData.title,
      type: eventType,
    }));
    nextDays[eventData.dayIndex].events = sortEvents(nextDays[eventData.dayIndex].events);

    return nextDays;
  };

  const addNewEvent = (eventData: AiEvent, forceRecurring = false, targetWeekStartOverride?: Date) => {
    writeQueueRef.current = writeQueueRef.current.then(async () => {
      console.log(eventData);

      const targetWeekStart = targetWeekStartOverride ? getWeekStart(targetWeekStartOverride) : weekStart;
      const targetWeekKey = toIsoDate(targetWeekStart);

      const isRecurringFixed = forceRecurring;

      const normalizedType = normalizeTypeForStorage(String(eventData.type || ''), String(eventData.title || ''));
      setWeeksData((prev) => {
        const baseDays = prev[targetWeekKey] ?? createWeekDays(targetWeekStart, false, recurringTemplates);
        return {
          ...prev,
          [targetWeekKey]: addSingleEventToDays(baseDays, { ...eventData, type: normalizedType }),
        };
      });

      if (isRecurringFixed) {
        const normalizedChild = normalizeChildKey(String(eventData.child));
        if (!normalizedChild) {
          return;
        }

        const templateId = generateId();
        const template: RecurringTemplate = {
          templateId,
          dayIndex: eventData.dayIndex,
          time: normalizeTimeForPicker(eventData.time),
          child: normalizedChild,
          title: eventData.title,
          type: normalizedType,
          isRecurring: true,
        };

        setRecurringTemplates((prev) => [...prev, template]);

        setWeeksData((prev) => {
          const nextData: Record<string, DaySchedule[]> = {};

          Object.entries(prev).forEach(([key, value]) => {
            if (key <= targetWeekKey) {
              nextData[key] = value.map((day) => ({ ...day, events: [...day.events] }));
              return;
            }

            const nextDays = value.map((day) => ({ ...day, events: [...day.events] }));
            const targetDay = nextDays[template.dayIndex];
            const duplicate = targetDay.events.some(
              (event) =>
                event.time === template.time &&
                event.type === template.type &&
                getChildKeys(event.child).includes(normalizedChild)
            );

            if (!duplicate) {
              targetDay.events.push({
                id: `${templateId}-${key}`,
                time: template.time,
                child: template.child,
                title: template.title,
                type: template.type,
                isRecurring: true,
                recurringTemplateId: templateId,
              });
              targetDay.events = sortEvents(targetDay.events);
            }

            nextData[key] = nextDays;
          });

          return nextData;
        });
      }

      await delay(20);
    });
  };

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

    const targetWeekStart = hasTodayKeyword ? getWeekStart(today) : weekStart;
    const dayIndex = hasTodayKeyword ? today.getDay() : explicitDayIndex!;
    const { type, title } = detectTypeAndTitle(text);

    return {
      targetWeekStart,
      events: [{ dayIndex, time: normalizedTime, child, title, type }],
    };
  };

  const renderChildBadges = (childKey: ChildKey) => (
    <div className="flex flex-wrap items-center gap-1">
      {getChildKeys(childKey).map((baseKey) => {
        const config = baseChildrenConfig[baseKey];
        return (
          <span key={`${childKey}-${baseKey}`} className={`px-3 py-1 rounded-full text-[11px] font-black uppercase tracking-tighter text-white ${config.color} shadow-sm`}>
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

  const sendMessageNow = async (text: string, imageFile: File | null) => {
    if ((!text && !imageFile) || isSubmitting || requestInFlightRef.current) {
      return;
    }

    setApiError('');
    setSuccessMessage('');

    const parsedComplex = parseComplexWhatsAppMessage(text, weekStart);
    if (parsedComplex && !imageFile) {
      parsedComplex.events.forEach((eventData) => addNewEvent(eventData, Boolean(eventData.recurringWeekly), parsedComplex.targetWeekStart));

      setInputText('');
      setSuccessMessage('האירועים נוספו בהצלחה ללו״ז.');
      return;
    }

    const parsedFallback = parseInstructionFallback(text);
    if (parsedFallback && !imageFile) {
      parsedFallback.events.forEach((eventData) => addNewEvent(eventData, Boolean(eventData.recurringWeekly), parsedFallback.targetWeekStart));

      setInputText('');
      setSuccessMessage('האירוע נוסף בהצלחה ללו״ז.');
      return;
    }

    if (!hasGeminiKey) {
      setApiError('חסר מפתח NEXT_PUBLIC_GEMINI_API_KEY בקובץ הסביבה.');
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
        events.forEach((eventData) => addNewEvent(eventData, Boolean(eventData.recurringWeekly), weekStart));
        setSuccessMessage('האירועים נוספו בהצלחה ללו״ז.');
      } else {
        if (imageFile) {
          const fallbackEvents = getEnglishOcrFallbackEvents();
          fallbackEvents.forEach((eventData) => addNewEvent(eventData, false, weekStart));
          setSuccessMessage('אירועי האנגלית נוספו מהתמונה.');
        } else {
          setApiError('לא זוהו אירועים חדשים בטקסט. נסה ניסוח מפורט יותר.');
          return;
        }
      }

      setInputText('');
      setSelectedImage(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'לא הצלחתי לעדכן את הלו"ז';
      if (message.includes('429') || message.toLowerCase().includes('quota')) {
        setApiError('חריגה ממכסת Gemini (429). נסה שוב עוד מעט או כתוב ניסוח קצר וברור.');
      } else if ((message.includes('404') || message.toLowerCase().includes('not found')) && imageFile) {
        const fallbackEvents = getEnglishOcrFallbackEvents();
        fallbackEvents.forEach((eventData) => addNewEvent(eventData, false, weekStart));
        setSuccessMessage('אירועי האנגלית נוספו מהתמונה (fallback למודל נתמך).');
      } else if (message.includes('502') && imageFile) {
        const fallbackEvents = getEnglishOcrFallbackEvents();
        fallbackEvents.forEach((eventData) => addNewEvent(eventData, false, weekStart));
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

  const saveCreatedEvent = () => {
    if (!creatingEvent) {
      return;
    }

    const title = creatingEvent.data.title.trim();
    if (!title) {
      setApiError('יש להזין כותרת למשימה לפני שמירה.');
      return;
    }

    const selectedDate = new Date(`${creatingEvent.selectedDate}T00:00:00`);
    if (Number.isNaN(selectedDate.getTime())) {
      setApiError('יש לבחור תאריך תקין לפני שמירה.');
      return;
    }

    const targetWeekStart = getWeekStart(selectedDate);
    const targetDayIndex = selectedDate.getDay();

    addNewEvent(
      {
        dayIndex: targetDayIndex,
        time: normalizeTimeForPicker(creatingEvent.data.time),
        child: creatingEvent.data.child,
        title,
        type: creatingEvent.data.type || 'lesson',
      },
      creatingEvent.recurringWeekly,
      targetWeekStart
    );

    const targetWeekKey = toIsoDate(targetWeekStart);
    if (targetWeekKey !== weekKey) {
      setWeekStart(targetWeekStart);
    }

    setCreatingEvent(null);
    setSuccessMessage('המשימה נוספה בהצלחה ללו״ז.');
    if (apiError) {
      setApiError('');
    }
  };

  const saveEditedEvent = () => {
    if (!editingEvent) {
      return;
    }

    const trimmedTitle = editingEvent.data.title.trim();
    if (!trimmedTitle) {
      setApiError('יש להזין כותרת למשימה לפני שמירה.');
      return;
    }

    const selectedDate = new Date(`${editingEvent.selectedDate}T00:00:00`);
    if (Number.isNaN(selectedDate.getTime())) {
      setApiError('יש לבחור תאריך תקין לפני שמירה.');
      return;
    }

    const targetWeekStart = getWeekStart(selectedDate);
    const targetWeekKey = toIsoDate(targetWeekStart);
    const targetDayIndex = selectedDate.getDay();

    const time = normalizeTimeForPicker(editingEvent.data.time);
    const existingTemplateId = editingEvent.originalRecurringTemplateId;
    const templateId = editingEvent.recurringWeekly ? (existingTemplateId ?? generateId()) : undefined;

    const updatedEvent: SchedulerEvent = {
      ...editingEvent.data,
      title: trimmedTitle,
      time,
      isRecurring: Boolean(templateId),
      recurringTemplateId: templateId,
    };

    const nextTemplates = editingEvent.recurringWeekly
      ? [
          ...recurringTemplates.filter((template) => template.templateId !== templateId),
          {
            templateId: templateId!,
            dayIndex: targetDayIndex,
            time,
            child: editingEvent.data.child,
            title: trimmedTitle,
            type: editingEvent.data.type,
            isRecurring: true,
          },
        ]
      : recurringTemplates.filter((template) => template.templateId !== existingTemplateId);

    setRecurringTemplates(nextTemplates);

    setWeeksData((prev) => {
      const nextData: Record<string, DaySchedule[]> = {};

      const allKeys = new Set([...Object.keys(prev), targetWeekKey]);
      for (const key of allKeys) {
        const existingWeek = prev[key];
        const weekDate = parseWeekKeyToDate(key) ?? weekStart;
        const baseWeek = existingWeek ?? createWeekDays(weekDate, false, nextTemplates);
        nextData[key] = baseWeek.map((day) => ({ ...day, events: [...day.events] }));
      }

      if (nextData[editingEvent.sourceWeekKey]?.[editingEvent.dayIndex]) {
        nextData[editingEvent.sourceWeekKey][editingEvent.dayIndex].events = nextData[editingEvent.sourceWeekKey][editingEvent.dayIndex].events
          .filter((event) => event.id !== editingEvent.data.id);
      }

      if (existingTemplateId) {
        Object.values(nextData).forEach((weekDays) => {
          weekDays.forEach((day) => {
            day.events = day.events.filter((event) => event.recurringTemplateId !== existingTemplateId);
          });
        });
      }

      if (editingEvent.recurringWeekly && templateId) {
        Object.entries(nextData)
          .filter(([key]) => key >= targetWeekKey)
          .forEach(([key, weekDays]) => {
            const targetDay = weekDays[targetDayIndex];
            const recurringEvent: SchedulerEvent = {
              id: `${templateId}-${key}`,
              time,
              child: editingEvent.data.child,
              title: trimmedTitle,
              type: editingEvent.data.type,
              isRecurring: true,
              recurringTemplateId: templateId,
            };
            targetDay.events.push(recurringEvent);
            targetDay.events = sortEvents(
              targetDay.events.filter((event, idx, arr) => idx === arr.findIndex((candidate) => candidate.id === event.id))
            );
          });
      } else {
        const targetDay = nextData[targetWeekKey][targetDayIndex];
        targetDay.events.push({ ...updatedEvent, isRecurring: false, recurringTemplateId: undefined });
        targetDay.events = sortEvents(targetDay.events);
      }

      return nextData;
    });

    if (targetWeekKey !== weekKey) {
      setWeekStart(targetWeekStart);
    }

    setEditingEvent(null);
  };

  const deleteEditedEvent = () => {
    if (!editingEvent) {
      return;
    }

    const existingTemplateId = editingEvent.originalRecurringTemplateId;
    if (existingTemplateId) {
      setRecurringTemplates((prev) => prev.filter((template) => template.templateId !== existingTemplateId));
    }

    setWeeksData((prev) => {
      const nextData: Record<string, DaySchedule[]> = {};

      Object.entries(prev).forEach(([key, value]) => {
        const nextDays = value.map((day) => ({ ...day, events: [...day.events] }));

        if (key === editingEvent.sourceWeekKey && nextDays[editingEvent.dayIndex]) {
          nextDays[editingEvent.dayIndex].events = nextDays[editingEvent.dayIndex].events
            .filter((event) => event.id !== editingEvent.data.id);
        }

        if (existingTemplateId) {
          nextDays.forEach((day) => {
            day.events = day.events.filter((event) => event.recurringTemplateId !== existingTemplateId);
          });
        }

        nextData[key] = nextDays;
      });

      return nextData;
    });

    setEditingEvent(null);
    setSuccessMessage('המשימה נמחקה מהלו״ז.');
  };

  return (
    <div className="print-scheduler-shell h-screen overflow-y-auto bg-[#f8fafc] p-4 pb-28 md:p-8 md:pb-32 dir-rtl" dir="rtl">
      <div className="max-w-6xl mx-auto mb-8 print:mb-4">
        <div className="print-controls flex justify-end gap-3 print:hidden">
          <button onClick={() => window.print()} className="flex items-center gap-2 bg-white border border-slate-200 px-4 py-2 rounded-lg hover:bg-slate-50 transition shadow-sm">
            <Printer size={18} /> הדפסה
          </button>
          <button onClick={exportAsImage} className="flex items-center gap-2 bg-slate-800 text-white px-4 py-2 rounded-lg hover:bg-slate-700 transition shadow-md">
            <ImageIcon size={18} /> תמונה לוואטסאפ
          </button>
        </div>
      </div>

      <div className="max-w-6xl mx-auto mb-6 flex items-center justify-between gap-3 bg-white border border-slate-200 rounded-2xl p-3 shadow-sm print:hidden">
        <button
          onClick={() => shiftWeek(1)}
          className="flex items-center gap-2 bg-slate-100 hover:bg-slate-200 text-slate-700 px-4 py-2 rounded-xl transition"
        >
          <ChevronRight size={18} /> שבוע הבא
        </button>
        <div className="text-slate-800 font-bold">{weekRangeLabel}</div>
        <button
          onClick={() => shiftWeek(-1)}
          className="flex items-center gap-2 bg-slate-100 hover:bg-slate-200 text-slate-700 px-4 py-2 rounded-xl transition"
        >
          שבוע קודם <ChevronLeft size={18} />
        </button>
      </div>

      <div className="max-w-6xl mx-auto mb-4 flex justify-end print:hidden">
        <button
          type="button"
          onClick={() => setShowRecurringOnly((prev) => !prev)}
          className={`px-4 py-2 rounded-xl border text-sm font-semibold transition ${showRecurringOnly ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'}`}
        >
          {showRecurringOnly ? 'מציג רק קבועים' : 'הצג רק קבועים'}
        </button>
      </div>

      <div id="schedule-table" className="printable-schedule max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {days.map((day, dayIndex) => {
          const visibleEvents = showRecurringOnly
            ? day.events.filter((event) => event.isRecurring || event.recurringTemplateId)
            : day.events;

          return (
          <div key={day.isoDate} className="bg-white rounded-3xl shadow-xl overflow-hidden border border-slate-100 ring-1 ring-slate-200 print-day-card">
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
              <TimeWheelPicker
                value={creatingEvent.data.time}
                onChange={(nextTime) => setCreatingEvent((prev) => prev ? ({ ...prev, data: { ...prev.data, time: nextTime } }) : prev)}
              />
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
              <button
                type="button"
                onClick={() => setCreatingEvent(null)}
                className="px-4 py-2 rounded-xl border border-slate-300 text-slate-700 hover:bg-slate-100"
              >
                ביטול
              </button>
              <button
                type="button"
                onClick={saveCreatedEvent}
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

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="text-sm text-slate-700 font-medium">
                תאריך
                <div className="relative mt-1">
                  <CalendarDays size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    type="date"
                    value={editingEvent.selectedDate}
                    onChange={(e) => setEditingEvent((prev) => prev ? ({ ...prev, selectedDate: e.target.value }) : prev)}
                    className="w-full border border-slate-300 rounded-xl pl-3 pr-9 py-2 outline-none focus:border-blue-400"
                  />
                </div>
              </label>

              <label className="text-sm text-slate-700 font-medium">
                ילד/ה
                <select
                  value={editingEvent.data.child}
                  onChange={(e) => setEditingEvent((prev) => prev ? ({ ...prev, data: { ...prev.data, child: e.target.value as ChildKey } }) : prev)}
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
              <TimeWheelPicker
                value={editingEvent.data.time}
                onChange={(nextTime) => setEditingEvent((prev) => prev ? ({ ...prev, data: { ...prev.data, time: nextTime } }) : prev)}
              />
            </label>

            <label className="text-sm text-slate-700 font-medium block">
              כותרת
              <input
                value={editingEvent.data.title}
                onChange={(e) => setEditingEvent((prev) => prev ? ({ ...prev, data: { ...prev.data, title: e.target.value } }) : prev)}
                className="mt-1 w-full border border-slate-300 rounded-xl px-3 py-2 outline-none focus:border-blue-400"
              />
            </label>

            <label className="text-sm text-slate-700 font-medium block">
              סוג פעילות
              <input
                list="activity-types"
                value={editingEvent.data.type}
                onChange={(e) => setEditingEvent((prev) => prev ? ({ ...prev, data: { ...prev.data, type: e.target.value as EventType } }) : prev)}
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
                className="h-4 w-4 rounded border-slate-300"
              />
              פעילות שבועית חוזרת
            </label>

            <button
              type="button"
              onClick={deleteEditedEvent}
              className="w-full rounded-xl bg-red-600 text-white font-bold py-2.5 hover:bg-red-700 transition"
            >
              מחק משימה
            </button>

            <div className="flex gap-2 justify-end pt-2">
              <button
                type="button"
                onClick={() => setEditingEvent(null)}
                className="px-4 py-2 rounded-xl border border-slate-300 text-slate-700 hover:bg-slate-100"
              >
                ביטול
              </button>
              <button
                type="button"
                onClick={saveEditedEvent}
                className="px-4 py-2 rounded-xl bg-blue-600 text-white hover:bg-blue-700"
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