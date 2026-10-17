/**
 * Configurable family roster.
 * NEXT_PUBLIC_FAMILY_MEMBERS="דני,מאיה,נועם" (comma-separated display names).
 * When unset, keeps the current household: רביד, עמית, אלין + parents סיון, רועי.
 */

export type FamilyRole = "child" | "parent";

export type FamilyMember = {
  key: string;
  name: string;
  /** Name stored on push subscriptions (סיוון keeps the historical spelling). */
  pushName: string;
  role: FamilyRole;
  color: string;
  iconColor: string;
  aliases: string[];
};

const COLOR_PALETTE = [
  { color: "bg-blue-500", iconColor: "text-blue-500" },
  { color: "bg-green-500", iconColor: "text-green-500" },
  { color: "bg-pink-500", iconColor: "text-pink-500" },
  { color: "bg-orange-500", iconColor: "text-orange-500" },
  { color: "bg-violet-500", iconColor: "text-violet-500" },
  { color: "bg-cyan-500", iconColor: "text-cyan-500" },
  { color: "bg-amber-500", iconColor: "text-amber-500" },
  { color: "bg-rose-500", iconColor: "text-rose-500" },
] as const;

const DEFAULT_CHILDREN = ["רביד", "עמית", "אלין"] as const;
const DEFAULT_PARENTS = ["סיון", "רועי"] as const;

type KnownSpec = { key: string; role: FamilyRole; aliases: string[]; pushName?: string };

const KNOWN_BY_NAME: Record<string, KnownSpec> = {
  "רביד": { key: "ravid", role: "child", aliases: ["ravid", "רביד"] },
  "עמית": { key: "amit", role: "child", aliases: ["amit", "עמית"] },
  "אלין": { key: "alin", role: "child", aliases: ["alin", "אלין"] },
  "רועי": { key: "roi", role: "parent", aliases: ["roi", "roei", "roey", "רועי"] },
  "סיון": { key: "sivan", role: "parent", aliases: ["sivan", "sivon", "סיון", "סיוון"], pushName: "סיוון" },
  "סיוון": { key: "sivan", role: "parent", aliases: ["sivan", "sivon", "סיון", "סיוון"], pushName: "סיוון" },
};

const HEBREW_SLUG: Record<string, string> = {
  א: "a",
  ב: "b",
  ג: "g",
  ד: "d",
  ה: "h",
  ו: "v",
  ז: "z",
  ח: "h",
  ט: "t",
  י: "y",
  כ: "k",
  ך: "k",
  ל: "l",
  מ: "m",
  ם: "m",
  נ: "n",
  ן: "n",
  ס: "s",
  ע: "a",
  פ: "p",
  ף: "p",
  צ: "tz",
  ץ: "tz",
  ק: "k",
  ר: "r",
  ש: "sh",
  ת: "t",
};

const parseNameList = (raw: string | undefined | null): string[] =>
  (raw ?? "")
    .split(/[,،]+/)
    .map((value) => value.trim())
    .filter(Boolean);

const slugifyUnknown = (name: string): string => {
  const slug = [...name]
    .map((ch) => HEBREW_SLUG[ch] ?? (/[a-z0-9]/i.test(ch) ? ch.toLowerCase() : ""))
    .join("")
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 24);
  if (slug) return slug;
  return `m${[...name].map((ch) => (ch.codePointAt(0) ?? 0).toString(16)).join("")}`;
};

const specForName = (name: string): KnownSpec => {
  const exact = KNOWN_BY_NAME[name];
  if (exact) return exact;
  const lower = name.toLowerCase();
  for (const spec of Object.values(KNOWN_BY_NAME)) {
    if (spec.key === lower || spec.aliases.some((alias) => alias.toLowerCase() === lower)) {
      return spec;
    }
  }
  return { key: slugifyUnknown(name), role: "child", aliases: [name, lower] };
};

const uniqueNames = (names: string[]) => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const spec = specForName(name);
    if (seen.has(spec.key)) continue;
    seen.add(spec.key);
    out.push(name);
  }
  return out;
};

const buildMembers = (): FamilyMember[] => {
  const fromEnv = parseNameList(process.env.NEXT_PUBLIC_FAMILY_MEMBERS);
  const names = fromEnv.length > 0 ? uniqueNames(fromEnv) : [...DEFAULT_CHILDREN, ...DEFAULT_PARENTS];
  return names.map((name, index) => {
    const spec = specForName(name);
    const palette = COLOR_PALETTE[index % COLOR_PALETTE.length];
    const displayName = spec.key === "sivan" ? "סיון" : name;
    const aliases = Array.from(new Set([displayName, name, spec.key, ...spec.aliases].filter(Boolean)));
    return {
      key: spec.key,
      name: displayName,
      pushName: spec.pushName ?? displayName,
      role: spec.role,
      color: palette.color,
      iconColor: palette.iconColor,
      aliases,
    };
  });
};

export const familyMembers: FamilyMember[] = buildMembers();
export const familyChildren = familyMembers.filter((member) => member.role === "child");
export const familyParents = familyMembers.filter((member) => member.role === "parent");
export const familyMemberKeys = familyMembers.map((member) => member.key);
export const defaultChildKey = familyChildren[0]?.key ?? familyMembers[0]?.key ?? "amit";

const byKey = new Map(familyMembers.map((member) => [member.key, member]));
const byAlias = new Map<string, FamilyMember>();
const byPushName = new Map<string, FamilyMember>();
for (const member of familyMembers) {
  byPushName.set(member.pushName, member);
  byPushName.set(member.pushName.toLowerCase(), member);
  for (const alias of member.aliases) {
    byAlias.set(alias, member);
    byAlias.set(alias.toLowerCase(), member);
  }
}

export const getMemberByAnyName = (value: string | null | undefined): FamilyMember | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return (
    byKey.get(trimmed) ??
    byAlias.get(trimmed) ??
    byAlias.get(trimmed.toLowerCase()) ??
    byPushName.get(trimmed) ??
    byPushName.get(trimmed.toLowerCase()) ??
    null
  );
};

export const resolvePushName = (value: string | null | undefined): string | null =>
  getMemberByAnyName(value)?.pushName ?? null;

export const baseChildrenConfig: Record<string, { name: string; color: string; iconColor: string }> =
  Object.fromEntries(
    familyMembers.map((member) => [member.key, { name: member.name, color: member.color, iconColor: member.iconColor }]),
  );

export const familyPairOptions: Array<{ key: string; label: string; keys: string[] }> = (() => {
  const kids = familyChildren;
  const pairs: Array<{ key: string; label: string; keys: string[] }> = [];
  for (let i = 0; i < kids.length; i += 1) {
    for (let j = i + 1; j < kids.length; j += 1) {
      const a = kids[i];
      const b = kids[j];
      pairs.push({
        key: `${a.key}_${b.key}`,
        label: `${a.name} ו${b.name} (ביחד)`,
        keys: [a.key, b.key],
      });
    }
  }
  return pairs;
})();

const pairByKey = new Map(familyPairOptions.map((pair) => [pair.key, pair]));
for (const pair of familyPairOptions) {
  pairByKey.set(`${pair.keys[1]}_${pair.keys[0]}`, pair);
}

export const childFormOptions: Array<{ key: string; label: string }> = [
  ...familyMembers.map((member) => ({ key: member.key, label: member.name })),
  ...familyPairOptions.map((pair) => ({ key: pair.key, label: pair.label })),
];

export const allowedScheduleChildKeys: string[] = [
  ...familyMemberKeys,
  ...familyPairOptions.flatMap((pair) => [pair.key, `${pair.keys[1]}_${pair.keys[0]}`]),
];

export const childLabelMap: Record<string, string> = Object.fromEntries([
  ...familyMembers.flatMap((member) => member.aliases.map((alias) => [alias, member.name] as const)),
  ...familyPairOptions.map((pair) => [pair.key, `${pair.keys.map((key) => byKey.get(key)?.name ?? key).join(" ו")}`] as const),
]);

export const resolveMemberKey = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const trimmed = value
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\u00a0/g, " ")
    .trim();
  if (!trimmed) return null;
  return getMemberByAnyName(trimmed)?.key ?? null;
};

export const isFamilyMemberKey = (value: string): boolean => byKey.has(value) || Boolean(resolveMemberKey(value));
export const isChildMemberKey = (value: string): boolean => {
  const key = resolveMemberKey(value);
  return Boolean(key && byKey.get(key)?.role === "child");
};
export const isParentMemberKey = (value: string): boolean => {
  const key = resolveMemberKey(value);
  return Boolean(key && byKey.get(key)?.role === "parent");
};

export const labelForMemberKey = (key: string): string => {
  const pair = pairByKey.get(key);
  if (pair) return pair.keys.map((part) => byKey.get(part)?.name ?? part).join(" ו");
  return byKey.get(key)?.name ?? childLabelMap[key] ?? key;
};

export const parseMemberKeysFromChildField = (child: string): string[] => {
  const resolved = resolveMemberKey(child);
  if (resolved) return [resolved];
  const pair = pairByKey.get(child.trim()) ?? pairByKey.get(child.trim().toLowerCase());
  if (pair) return pair.keys;
  const parts = child
    .trim()
    .split(/[_,\s]+/)
    .map((token) => resolveMemberKey(token))
    .filter((token): token is string => Boolean(token));
  if (parts.length) return [...new Set(parts)];
  return [];
};

export const getMemberKeysFromChildField = (child: string): string[] => {
  const keys = parseMemberKeysFromChildField(child);
  return keys.length ? keys : [defaultChildKey];
};

export const isAllowedScheduleChild = (value: string): boolean => {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (allowedScheduleChildKeys.includes(trimmed)) return true;
  if (resolveMemberKey(trimmed)) return true;
  const keys = parseMemberKeysFromChildField(trimmed);
  return keys.length > 0 && keys.every((key) => byKey.has(key));
};

export const childPushNamesFromField = (rawChild: string): string[] =>
  parseMemberKeysFromChildField(rawChild)
    .map((key) => byKey.get(key))
    .filter((member): member is FamilyMember => Boolean(member && member.role === "child"))
    .map((member) => member.pushName);

export const parentPushNamesFromField = (rawChild: string): string[] =>
  parseMemberKeysFromChildField(rawChild)
    .map((key) => byKey.get(key))
    .filter((member): member is FamilyMember => Boolean(member && member.role === "parent"))
    .map((member) => member.pushName);

export const isChildPushName = (value: string): boolean => getMemberByAnyName(value)?.role === "child";
export const isParentPushName = (value: string): boolean => getMemberByAnyName(value)?.role === "parent";

export const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const memberDisplayNames = familyMembers.map((member) => member.name);
export const childDisplayNames = familyChildren.map((member) => member.name);
export const parentDisplayNames = familyParents.map((member) => member.name);
export const pushUserNames = familyMembers.map((member) => member.pushName);
export const pushChildNames = familyChildren.map((member) => member.pushName);
export const pushParentNames = familyParents.map((member) => member.pushName);

export const memberNamePattern = memberDisplayNames.map(escapeRegExp).join("|");
export const memberAliasPattern = Array.from(
  new Set(familyMembers.flatMap((member) => member.aliases)),
).map(escapeRegExp).join("|");

export const findMembersMentionedInText = (text: string): FamilyMember[] =>
  familyMembers.filter((member) => member.aliases.some((alias) => alias && text.includes(alias)));
