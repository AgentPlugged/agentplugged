import { z } from "zod";

/**
 * Notifications without content. A notification carries an opaque identifier, a category and a
 * level of urgency, and nothing else: the relay never learns a product's name, a title or a text.
 * The machine decides what is urgent (it knows the content); the relay only forwards, to the
 * phones of the account, through the push services of the platforms.
 */

/** The platforms a phone can be reached on: APNs (iOS) and FCM (Android), directly. */
export const PUSH_PLATFORMS = ["ios", "android"] as const;
export type PushPlatform = (typeof PUSH_PLATFORMS)[number];

/** What a notification is about, in the words of the product (never a product's own text). */
export const NOTIFY_CATEGORIES = ["decision", "permission", "merge"] as const;
export type NotifyCategory = (typeof NOTIFY_CATEGORIES)[number];

/** How hard a notification interrupts. */
export const NOTIFY_URGENCIES = ["urgent", "normal"] as const;
export type NotifyUrgency = (typeof NOTIFY_URGENCIES)[number];

/** The device token a push service gave the phone: printable ASCII without spaces, bounded. */
export const PUSH_TOKEN_MAX_CHARS = 4096;
export const PushTokenSchema = z
  .string()
  .min(16)
  .max(PUSH_TOKEN_MAX_CHARS)
  .regex(/^[\x21-\x7e]+$/);

/** The opaque identifier of a notification: 43 characters of base64url (a digest). */
export const NotifyIdSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/**
 * What a notification carries, in total. The relay builds the platform message from this and from
 * a fixed text of its own; nothing of the product is in it.
 */
export const PushNoticeSchema = z.strictObject({
  id: NotifyIdSchema,
  category: z.enum(NOTIFY_CATEGORIES),
  urgency: z.enum(NOTIFY_URGENCIES),
});
export type PushNotice = z.infer<typeof PushNoticeSchema>;

/** The short names the three fields carry in the data of a platform message. */
export const PUSH_DATA_KEYS = { id: "i", category: "c", urgency: "u" } as const;

/** The data of a platform message for a notice: strings only, as both platforms require. */
export function pushDataOf(notice: PushNotice): Record<string, string> {
  return {
    [PUSH_DATA_KEYS.id]: notice.id,
    [PUSH_DATA_KEYS.category]: notice.category,
    [PUSH_DATA_KEYS.urgency]: notice.urgency,
  };
}

/**
 * Reads the data of a received notification; `undefined` when it is not one of ours. Unknown
 * fields are dropped, a notice that does not fit is no notice.
 */
export function noticeFromPushData(data: unknown): PushNotice | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const record = data as Record<string, unknown>;
  const parsed = PushNoticeSchema.safeParse({
    id: record[PUSH_DATA_KEYS.id],
    category: record[PUSH_DATA_KEYS.category],
    urgency: record[PUSH_DATA_KEYS.urgency],
  });
  return parsed.success ? parsed.data : undefined;
}

/**
 * Which points interrupt. The machine decides (it knows the content) and every surface that sorts
 * or colours a point by urgency reads this same rule, so that « urgent » means one thing.
 */
type CheckpointRecord = Readonly<Record<string, unknown>>;

/** True when the point holds back an agent or sits at a high risk. */
export function isPressingPoint(point: CheckpointRecord): boolean {
  return point.risk === "high" || (Array.isArray(point.blocks) && point.blocks.length > 0);
}

/** What a point is about, in the words of a notification. */
export function notifyCategoryOf(point: CheckpointRecord): NotifyCategory {
  if (point.type === "permission") return "permission";
  if (point.type === "story" && point.source === "merge" && typeof point.story === "string") {
    return "merge";
  }
  return "decision";
}

/**
 * Whether an open point interrupts: a pressing one, a permission (an agent waits for it) or a story
 * ready to merge. Everything else is served in the briefing, not by a notification.
 */
export function interruptsCreator(point: CheckpointRecord): boolean {
  return isPressingPoint(point) || notifyCategoryOf(point) !== "decision";
}

/** The surfaces of the creator that can be notified (the watch comes with its own app). */
export const NOTIFY_SURFACES = ["web", "mobile"] as const;
export type NotifySurface = (typeof NOTIFY_SURFACES)[number];

/** What a surface rings for: only the urgent, everything that comes back to the creator, nothing. */
export const SURFACE_CHOICES = ["urgent", "all", "none"] as const;
export type SurfaceChoice = (typeof SURFACE_CHOICES)[number];

/** A surface is active when its foreground has seen an interaction within this time. */
export const PRESENCE_ACTIVE_MS = 120_000;
/** How often an active surface says it still is. */
export const PRESENCE_HEARTBEAT_MS = 30_000;
/** How long the relay believes an active surface that went quiet (missed heartbeats, closed tab). */
export const PRESENCE_TTL_MS = 75_000;

/** A time zone name as the platforms give it (`Europe/Paris`): bounded, no free text. */
export const TimeZoneSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/);

const CategoriesSchema = z
  .array(z.enum(NOTIFY_CATEGORIES))
  .max(NOTIFY_CATEGORIES.length)
  .refine((list) => new Set(list).size === list.length, { message: "duplicate category" });

const MinuteOfDaySchema = z.number().int().min(0).max(1439);

/**
 * What the creator chose about notifications. It holds no product text and no content: categories,
 * hours and surfaces. The relay keeps it in clear because it applies it (it never sees more than an
 * opaque notice); the same document is shown and changed from every surface.
 */
export const NotifyPrefsSchema = z.strictObject({
  /** The categories that notify at all. */
  types: CategoriesSchema,
  /** Active on one surface: the others stay quiet. Off: each surface follows its own choice. */
  presence: z.boolean(),
  surfaces: z.strictObject({
    web: z.enum(SURFACE_CHOICES),
    mobile: z.enum(SURFACE_CHOICES),
  }),
  quiet: z.strictObject({
    enabled: z.boolean(),
    /** Minute of the day the silence starts and ends, in `tz`. Equal values mean no silence. */
    from: MinuteOfDaySchema,
    to: MinuteOfDaySchema,
    tz: TimeZoneSchema,
    /** The urgent categories that still ring during the silence: none by default. */
    pass: CategoriesSchema,
  }),
});
export type NotifyPrefs = z.infer<typeof NotifyPrefsSchema>;

/** Out of the box: all categories, urgent only on both surfaces, presence on, no silence set. */
export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = {
  types: [...NOTIFY_CATEGORIES],
  presence: true,
  surfaces: { web: "urgent", mobile: "urgent" },
  quiet: { enabled: false, from: 22 * 60, to: 7 * 60, tz: "UTC", pass: [] },
};

/** The minute of the day (0 to 1439) at `at` in the zone `tz`; UTC when the zone is unknown. */
export function minuteOfDay(at: Date, tz: string): number {
  const read = (zone: string): number => {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(at);
    const part = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
    return (part("hour") % 24) * 60 + part("minute");
  };
  try {
    return read(tz);
  } catch {
    return read("UTC");
  }
}

/** Whether `at` falls in the creator's quiet hours (a window that crosses midnight is fine). */
export function inQuietHours(quiet: NotifyPrefs["quiet"], at: Date): boolean {
  if (!quiet.enabled || quiet.from === quiet.to) return false;
  const minute = minuteOfDay(at, quiet.tz);
  return quiet.from < quiet.to
    ? minute >= quiet.from && minute < quiet.to
    : minute >= quiet.from || minute < quiet.to;
}
