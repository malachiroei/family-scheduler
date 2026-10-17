/** Client-safe helpers for basketball fixture leagues (no Node APIs). */

export type FixtureLeagueKind = "katsal" | "girls" | "youth" | "other";

export const isKatsalLeague = (hay: string) => /קט[\s\-]?סל/.test(hay);

export const classifyFixtureLeague = (leagueOrTitle: string | null | undefined): FixtureLeagueKind => {
  const hay = leagueOrTitle ?? "";
  if (isKatsalLeague(hay)) return "katsal";
  if (/ילדות/.test(hay)) return "girls";
  if (/נערים/.test(hay)) return "youth";
  return "other";
};

export const compactLeagueLabel = (league: string | null | undefined): string => {
  const raw = (league ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  if (isKatsalLeague(raw)) {
    const letter = (raw.match(/קט[\s\-]?סל\s*([א-ת]|\d+)/i) || [])[1];
    return letter ? `קט-סל ${letter}` : "קט-סל";
  }
  return raw
    .replace(/תל[\s\-]*אביב/gi, "")
    .replace(/\bבנות\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
};

export type FixtureLeagueBadge = {
  text: string;
  wrapClass: string;
  pillClass: string;
};

export const fixtureLeagueBadge = (
  leagueOrTitle: string | null | undefined,
): FixtureLeagueBadge | null => {
  const kind = classifyFixtureLeague(leagueOrTitle);
  if (kind === "katsal") {
    return {
      text: "קט-סל · תגבור",
      wrapClass: "bg-amber-50 border-amber-300",
      pillClass: "text-amber-900 bg-amber-100 border-amber-300",
    };
  }
  if (kind === "girls") {
    return {
      text: "ילדות ב",
      wrapClass: "bg-emerald-50 border-emerald-300",
      pillClass: "text-emerald-900 bg-emerald-100 border-emerald-300",
    };
  }
  if (kind === "youth") {
    return {
      text: "נערים ב",
      wrapClass: "bg-sky-50 border-sky-300",
      pillClass: "text-sky-900 bg-sky-100 border-sky-300",
    };
  }
  return null;
};
