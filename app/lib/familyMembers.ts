/**
 * Configurable family roster.
 * Priority: DB (`scheduler_state` / family_roster) → NEXT_PUBLIC_FAMILY_MEMBERS → default household.
 */

export type FamilyRole = "child" | "parent";
export type FamilyRosterSource = "db" | "env" | "default";

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

export type StoredFamilyMember = {
  name: string;
  role: FamilyRole;
  color?: string;
  key?: string;
};

export const FAMILY_ROSTER_STATE_KEY = "family_roster";
export const FAMILY_ROSTER_ONBOARDING_KEY = "family-scheduler-roster-onboarding-v1";

export const ONBOARDING_PLACEHOLDERS = {
  parent: "שם ההורה",
  child: "שם הילד",
} as const;

export const COLOR_PALETTE = [
  { color: "bg-blue-500", iconColor: "text-blue-500" },
  { color: "bg-green-500", iconColor: "text-green-500" },
  { color: "bg-pink-500", iconColor: "text-pink-500" },
  { color: "bg-orange-500", iconColor: "text-orange-500" },
  { color: "bg-violet-500", iconColor: "text-violet-500" },
  { color: "bg-cyan-500", iconColor: "text-cyan-500" },
  { color: "bg-amber-500", iconColor: "text-amber-500" },
  { color: "bg-rose-500", iconColor: "text-rose-500" },
] as const;

/** Empty starter rows for a new tenant — never the current household names. */
export const blankOnboardingMembers = (): FamilyMember[] => [
  { key: "", name: "", pushName: "", role: "parent", color: COLOR_PALETTE[0].color, iconColor: COLOR_PALETTE[0].iconColor, aliases: [] },
  { key: "", name: "", pushName: "", role: "parent", color: COLOR_PALETTE[1].color, iconColor: COLOR_PALETTE[1].iconColor, aliases: [] },
  { key: "", name: "", pushName: "", role: "child", color: COLOR_PALETTE[2].color, iconColor: COLOR_PALETTE[2].iconColor, aliases: [] },
  { key: "", name: "", pushName: "", role: "child", color: COLOR_PALETTE[3].color, iconColor: COLOR_PALETTE[3].iconColor, aliases: [] },
];

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

export const parseNameList = (raw: string | undefined | null): string[] =>
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

export const specForName = (name: string): KnownSpec => {
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

export const iconColorFromBg = (color: string) =>
  color.startsWith("bg-") ? `text-${color.slice(3)}` : color;

const paletteAt = (index: number) => COLOR_PALETTE[index % COLOR_PALETTE.length];

const isPaletteColor = (color: string | undefined): color is string =>
  Boolean(color && COLOR_PALETTE.some((entry) => entry.color === color));

export const hydrateMember = (item: StoredFamilyMember, index: number, usedKeys?: Set<string>): FamilyMember => {
  const name = item.name.trim();
  const spec = specForName(name);
  const role: FamilyRole = item.role === "parent" || item.role === "child" ? item.role : spec.role;
  const palette = paletteAt(index);
  const color = isPaletteColor(item.color) ? item.color : palette.color;
  const iconColor = COLOR_PALETTE.find((entry) => entry.color === color)?.iconColor ?? iconColorFromBg(color);
  let key = (item.key || spec.key).trim() || slugifyUnknown(name) || `member${index + 1}`;
  if (usedKeys) {
    const base = key;
    let n = 2;
    while (usedKeys.has(key)) {
      key = `${base}${n}`;
      n += 1;
    }
    usedKeys.add(key);
  }
  const displayName = key === "sivan" ? "סיון" : name;
  const pushName = spec.pushName ?? displayName;
  const aliases = Array.from(new Set([displayName, name, key, pushName, ...spec.aliases].filter(Boolean)));
  return { key, name: displayName, pushName, role, color, iconColor, aliases };
};

export const hydrateStoredMembers = (items: StoredFamilyMember[]): FamilyMember[] => {
  const usedKeys = new Set<string>();
  return items
    .filter((item) => item && typeof item.name === "string" && item.name.trim())
    .map((item, index) => hydrateMember(item, index, usedKeys));
};

export const serializeFamilyMembers = (members: FamilyMember[]): StoredFamilyMember[] =>
  members.map((member) => ({
    name: member.name,
    role: member.role,
    color: member.color,
    key: member.key,
  }));

const membersFromNames = (names: string[], forceChild = false): FamilyMember[] => {
  const usedKeys = new Set<string>();
  return uniqueNames(names).map((name, index) => {
    const spec = specForName(name);
    return hydrateMember(
      { name, role: forceChild ? "child" : spec.role, key: spec.key },
      index,
      usedKeys,
    );
  });
};

export const envFamilyMemberNames = parseNameList(process.env.NEXT_PUBLIC_FAMILY_MEMBERS);
export const hasEnvFamilyMembers = envFamilyMemberNames.length > 0;

export const defaultFamilyMembers: FamilyMember[] = membersFromNames([...DEFAULT_CHILDREN, ...DEFAULT_PARENTS]);

const envOrDefaultMembers = (): FamilyMember[] => {
  if (hasEnvFamilyMembers) {
    return membersFromNames(envFamilyMemberNames);
  }
  return defaultFamilyMembers;
};

export type FamilyRoster = {
  members: FamilyMember[];
  children: FamilyMember[];
  parents: FamilyMember[];
  memberKeys: string[];
  source: FamilyRosterSource;
  configured: boolean;
  defaultChildKey: string;
  baseChildrenConfig: Record<string, { name: string; color: string; iconColor: string }>;
  familyPairOptions: Array<{ key: string; label: string; keys: string[] }>;
  childFormOptions: Array<{ key: string; label: string }>;
  allowedScheduleChildKeys: string[];
  childLabelMap: Record<string, string>;
  memberDisplayNames: string[];
  childDisplayNames: string[];
  parentDisplayNames: string[];
  pushUserNames: string[];
  pushChildNames: string[];
  pushParentNames: string[];
  memberAliasPattern: string;
  memberNamePattern: string;
  resolveMemberKey: (value: string | null | undefined) => string | null;
  getMemberByAnyName: (value: string | null | undefined) => FamilyMember | null;
  resolvePushName: (value: string | null | undefined) => string | null;
  isFamilyMemberKey: (value: string) => boolean;
  isChildMemberKey: (value: string) => boolean;
  isParentMemberKey: (value: string) => boolean;
  isChildPushName: (value: string) => boolean;
  isParentPushName: (value: string) => boolean;
  isAllowedScheduleChild: (value: string) => boolean;
  labelForMemberKey: (key: string) => string;
  parseMemberKeysFromChildField: (child: string) => string[];
  getMemberKeysFromChildField: (child: string) => string[];
  childPushNamesFromField: (rawChild: string) => string[];
  parentPushNamesFromField: (rawChild: string) => string[];
  findMembersMentionedInText: (text: string) => FamilyMember[];
  serialize: () => StoredFamilyMember[];
};

export const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const createFamilyRoster = (
  membersInput: FamilyMember[],
  source: FamilyRosterSource = "default",
): FamilyRoster => {
  const members = membersInput.length ? membersInput : defaultFamilyMembers;
  const children = members.filter((member) => member.role === "child");
  const parents = members.filter((member) => member.role === "parent");
  const memberKeys = members.map((member) => member.key);
  const defaultChildKey = children[0]?.key ?? members[0]?.key ?? "amit";

  const byKey = new Map(members.map((member) => [member.key, member]));
  const byAlias = new Map<string, FamilyMember>();
  const byPushName = new Map<string, FamilyMember>();
  for (const member of members) {
    byPushName.set(member.pushName, member);
    byPushName.set(member.pushName.toLowerCase(), member);
    for (const alias of member.aliases ?? []) {
      byAlias.set(alias, member);
      byAlias.set(alias.toLowerCase(), member);
    }
  }

  const getMemberByAnyName = (value: string | null | undefined): FamilyMember | null => {
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

  const resolveMemberKey = (value: string | null | undefined): string | null => {
    if (!value) return null;
    const trimmed = value
      .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
      .replace(/\u00a0/g, " ")
      .trim();
    if (!trimmed) return null;
    return getMemberByAnyName(trimmed)?.key ?? null;
  };

  const familyPairOptions: Array<{ key: string; label: string; keys: string[] }> = [];
  for (let i = 0; i < children.length; i += 1) {
    for (let j = i + 1; j < children.length; j += 1) {
      const a = children[i];
      const b = children[j];
      familyPairOptions.push({
        key: `${a.key}_${b.key}`,
        label: `${a.name} ו${b.name} (ביחד)`,
        keys: [a.key, b.key],
      });
    }
  }

  const pairByKey = new Map(familyPairOptions.map((pair) => [pair.key, pair]));
  for (const pair of familyPairOptions) {
    pairByKey.set(`${pair.keys[1]}_${pair.keys[0]}`, pair);
  }

  const childFormOptions = [
    ...members.map((member) => ({ key: member.key, label: member.name })),
    ...familyPairOptions.map((pair) => ({ key: pair.key, label: pair.label })),
  ];

  const allowedScheduleChildKeys = [
    ...memberKeys,
    ...familyPairOptions.flatMap((pair) => [pair.key, `${pair.keys[1]}_${pair.keys[0]}`]),
  ];

  const childLabelMap: Record<string, string> = Object.fromEntries([
    ...members.flatMap((member) => member.aliases.map((alias) => [alias, member.name] as const)),
    ...familyPairOptions.map(
      (pair) => [pair.key, `${pair.keys.map((key) => byKey.get(key)?.name ?? key).join(" ו")}`] as const,
    ),
  ]);

  const parseMemberKeysFromChildField = (child: string): string[] => {
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

  const getMemberKeysFromChildField = (child: string): string[] => {
    const keys = parseMemberKeysFromChildField(child);
    return keys.length ? keys : [defaultChildKey];
  };

  const isAllowedScheduleChild = (value: string): boolean => {
    const trimmed = value.trim();
    if (!trimmed) return false;
    if (allowedScheduleChildKeys.includes(trimmed)) return true;
    if (resolveMemberKey(trimmed)) return true;
    const keys = parseMemberKeysFromChildField(trimmed);
    return keys.length > 0 && keys.every((key) => byKey.has(key));
  };

  const labelForMemberKey = (key: string): string => {
    const pair = pairByKey.get(key);
    if (pair) return pair.keys.map((part) => byKey.get(part)?.name ?? part).join(" ו");
    return byKey.get(key)?.name ?? childLabelMap[key] ?? key;
  };

  const memberDisplayNames = members.map((member) => member.name);
  const childDisplayNames = children.map((member) => member.name);
  const parentDisplayNames = parents.map((member) => member.name);

  return {
    members,
    children,
    parents,
    memberKeys,
    source,
    configured: source !== "default",
    defaultChildKey,
    baseChildrenConfig: Object.fromEntries(
      members.map((member) => [member.key, { name: member.name, color: member.color, iconColor: member.iconColor }]),
    ),
    familyPairOptions,
    childFormOptions,
    allowedScheduleChildKeys,
    childLabelMap,
    memberDisplayNames,
    childDisplayNames,
    parentDisplayNames,
    pushUserNames: members.map((member) => member.pushName),
    pushChildNames: children.map((member) => member.pushName),
    pushParentNames: parents.map((member) => member.pushName),
    memberAliasPattern: Array.from(new Set(members.flatMap((member) => member.aliases ?? []))).map(escapeRegExp).join("|"),
    memberNamePattern: memberDisplayNames.map(escapeRegExp).join("|"),
    resolveMemberKey,
    getMemberByAnyName,
    resolvePushName: (value) => getMemberByAnyName(value)?.pushName ?? null,
    isFamilyMemberKey: (value) => byKey.has(value) || Boolean(resolveMemberKey(value)),
    isChildMemberKey: (value) => {
      const key = resolveMemberKey(value);
      return Boolean(key && byKey.get(key)?.role === "child");
    },
    isParentMemberKey: (value) => {
      const key = resolveMemberKey(value);
      return Boolean(key && byKey.get(key)?.role === "parent");
    },
    isChildPushName: (value) => getMemberByAnyName(value)?.role === "child",
    isParentPushName: (value) => getMemberByAnyName(value)?.role === "parent",
    isAllowedScheduleChild,
    labelForMemberKey,
    parseMemberKeysFromChildField,
    getMemberKeysFromChildField,
    childPushNamesFromField: (rawChild) =>
      parseMemberKeysFromChildField(rawChild)
        .map((key) => byKey.get(key))
        .filter((member): member is FamilyMember => Boolean(member && member.role === "child"))
        .map((member) => member.pushName),
    parentPushNamesFromField: (rawChild) =>
      parseMemberKeysFromChildField(rawChild)
        .map((key) => byKey.get(key))
        .filter((member): member is FamilyMember => Boolean(member && member.role === "parent"))
        .map((member) => member.pushName),
    findMembersMentionedInText: (text) =>
      members.filter((member) => (member.aliases ?? []).some((alias) => alias && text.includes(alias))),
    serialize: () => serializeFamilyMembers(members),
  };
};

export const fallbackRoster: FamilyRoster = createFamilyRoster(
  envOrDefaultMembers(),
  hasEnvFamilyMembers ? "env" : "default",
);

export const familyMembers = fallbackRoster.members;
export const familyChildren = fallbackRoster.children;
export const familyParents = fallbackRoster.parents;
export const familyMemberKeys = fallbackRoster.memberKeys;
export const defaultChildKey = fallbackRoster.defaultChildKey;
export const baseChildrenConfig = fallbackRoster.baseChildrenConfig;
export const familyPairOptions = fallbackRoster.familyPairOptions;
export const childFormOptions = fallbackRoster.childFormOptions;
export const allowedScheduleChildKeys = fallbackRoster.allowedScheduleChildKeys;
export const childLabelMap = fallbackRoster.childLabelMap;
export const getMemberByAnyName = fallbackRoster.getMemberByAnyName;
export const resolvePushName = fallbackRoster.resolvePushName;
export const resolveMemberKey = fallbackRoster.resolveMemberKey;
export const isFamilyMemberKey = fallbackRoster.isFamilyMemberKey;
export const isChildMemberKey = fallbackRoster.isChildMemberKey;
export const isParentMemberKey = fallbackRoster.isParentMemberKey;
export const labelForMemberKey = fallbackRoster.labelForMemberKey;
export const parseMemberKeysFromChildField = fallbackRoster.parseMemberKeysFromChildField;
export const getMemberKeysFromChildField = fallbackRoster.getMemberKeysFromChildField;
export const isAllowedScheduleChild = fallbackRoster.isAllowedScheduleChild;
export const childPushNamesFromField = fallbackRoster.childPushNamesFromField;
export const parentPushNamesFromField = fallbackRoster.parentPushNamesFromField;
export const isChildPushName = fallbackRoster.isChildPushName;
export const isParentPushName = fallbackRoster.isParentPushName;
export const memberDisplayNames = fallbackRoster.memberDisplayNames;
export const childDisplayNames = fallbackRoster.childDisplayNames;
export const parentDisplayNames = fallbackRoster.parentDisplayNames;
export const pushUserNames = fallbackRoster.pushUserNames;
export const pushChildNames = fallbackRoster.pushChildNames;
export const pushParentNames = fallbackRoster.pushParentNames;
export const memberNamePattern = fallbackRoster.memberNamePattern;
export const memberAliasPattern = fallbackRoster.memberAliasPattern;
export const findMembersMentionedInText = fallbackRoster.findMembersMentionedInText;
