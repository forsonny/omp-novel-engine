export type ProjectMode = "standalone" | "series" | "serial";

export type GateStatus = "pending" | "approved" | "rejected" | "needs_revision" | "blocked_by_audit";

export type ChapterVariantKind = "canon-tight" | "character-heavy" | "plot-accelerated";

export const chapterVariants: Array<{ id: ChapterVariantKind; purpose: string }> = [
  { id: "canon-tight", purpose: "Continuity-first, exact beat adherence, low canon risk." },
  { id: "character-heavy", purpose: "Emotional movement, relationship state, interior/exterior pressure." },
  { id: "plot-accelerated", purpose: "Momentum, event density, cliffhanger pressure, serial readability." }
];

export const sevenPointBeats = [
  "Hook",
  "First Plot Point",
  "First Pinch",
  "Midpoint",
  "Second Pinch",
  "Second Plot Point",
  "Resolution"
] as const;

export const serialArcScopes = [
  "serial_promise",
  "season",
  "book",
  "subplot",
  "major_character",
  "chapter",
  "episode"
] as const;

export const serialPromiseCategories = [
  "open_promise",
  "mystery",
  "foreshadowing",
  "payoff",
  "theme"
] as const;

export const serialPromiseStatuses = [
  "open",
  "advanced",
  "deferred",
  "paid_off",
  "dropped"
] as const;

export const serialPromiseVisibilities = [
  "reader",
  "private",
  "both"
] as const;

export const serialRecapAudiences = [
  "reader",
  "private"
] as const;

export type SerialArcScope = (typeof serialArcScopes)[number];
export type SerialPromiseCategory = (typeof serialPromiseCategories)[number];
export type SerialPromiseStatus = (typeof serialPromiseStatuses)[number];
export type SerialPromiseVisibility = (typeof serialPromiseVisibilities)[number];
export type SerialRecapAudience = (typeof serialRecapAudiences)[number];
