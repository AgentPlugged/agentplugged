import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOTIFY_PREFS,
  inQuietHours,
  interruptsCreator,
  isPressingPoint,
  minuteOfDay,
  NOTIFY_CATEGORIES,
  NotifyPrefsSchema,
  noticeFromPushData,
  notifyCategoryOf,
  PushNoticeSchema,
  PushTokenSchema,
  pushDataOf,
} from "./push.js";
import { RelayClientFrameSchema, RelayServerFrameSchema } from "./relay.js";

const ID = "A".repeat(43);
const notice = { id: ID, category: "decision", urgency: "urgent" } as const;

describe("une notification sans contenu", () => {
  it("ne porte qu'un identifiant opaque, une catégorie et un niveau d'urgence", () => {
    expect(PushNoticeSchema.safeParse(notice).success).toBe(true);
    expect(Object.keys(PushNoticeSchema.shape).sort()).toEqual(["category", "id", "urgency"]);
    // Nothing else is accepted: a title or a product name has no place to be.
    expect(PushNoticeSchema.safeParse({ ...notice, title: "Mise en production" }).success).toBe(
      false,
    );
    expect(PushNoticeSchema.safeParse({ ...notice, product: "Acme" }).success).toBe(false);
  });

  it("refuse un identifiant qui n'est pas un condensé et une catégorie inconnue", () => {
    expect(PushNoticeSchema.safeParse({ ...notice, id: "C12" }).success).toBe(false);
    expect(PushNoticeSchema.safeParse({ ...notice, category: "billing" }).success).toBe(false);
    expect(NOTIFY_CATEGORIES).toEqual(["decision", "permission", "merge"]);
  });

  it("se relit depuis les données du message de la plateforme, et rien d'autre ne passe", () => {
    expect(noticeFromPushData(pushDataOf(notice))).toEqual(notice);
    expect(noticeFromPushData({ ...pushDataOf(notice), extra: "x" })).toEqual(notice);
    expect(noticeFromPushData({ i: ID })).toBeUndefined();
    expect(noticeFromPushData(null)).toBeUndefined();
    expect(noticeFromPushData("texte")).toBeUndefined();
  });

  it("borne le jeton de la plateforme à de l'ASCII visible", () => {
    expect(PushTokenSchema.safeParse("a".repeat(64)).success).toBe(true);
    expect(PushTokenSchema.safeParse("court").success).toBe(false);
    expect(PushTokenSchema.safeParse(`${"a".repeat(20)} ${"b".repeat(20)}`).success).toBe(false);
    expect(PushTokenSchema.safeParse("é".repeat(40)).success).toBe(false);
    expect(PushTokenSchema.safeParse("a".repeat(5000)).success).toBe(false);
  });

  it("a ses trames dans le relais : enregistrer, retirer, notifier, et leurs réponses", () => {
    expect(
      RelayClientFrameSchema.safeParse({
        type: "push_register",
        platform: "ios",
        token: "a".repeat(64),
      }).success,
    ).toBe(true);
    expect(RelayClientFrameSchema.safeParse({ type: "push_unregister" }).success).toBe(true);
    expect(RelayClientFrameSchema.safeParse({ type: "notify", ...notice }).success).toBe(true);
    expect(
      RelayClientFrameSchema.safeParse({ type: "notify", ...notice, title: "x" }).success,
    ).toBe(false);
    expect(
      RelayClientFrameSchema.safeParse({
        type: "push_register",
        platform: "web",
        token: "a".repeat(40),
      }).success,
    ).toBe(false);
    expect(RelayServerFrameSchema.safeParse({ type: "push_registered" }).success).toBe(true);
    expect(RelayServerFrameSchema.safeParse({ type: "push_unregistered" }).success).toBe(true);
    expect(RelayServerFrameSchema.safeParse({ type: "notified", id: ID, sent: 2 }).success).toBe(
      true,
    );
  });
});

describe("l'urgence et le silence", () => {
  it("une seule règle d'urgence : risque élevé ou blocage ; permission et fusion interrompent aussi", () => {
    expect(isPressingPoint({ risk: "high" })).toBe(true);
    expect(isPressingPoint({ risk: "low", blocks: ["agent"] })).toBe(true);
    expect(isPressingPoint({ risk: "low", blocks: [] })).toBe(false);
    expect(interruptsCreator({ type: "document", risk: "low" })).toBe(false);
    expect(interruptsCreator({ type: "permission", risk: "low" })).toBe(true);
    expect(notifyCategoryOf({ type: "story", source: "merge", story: "1.1" })).toBe("merge");
    expect(notifyCategoryOf({ type: "story", source: "merge" })).toBe("decision");
  });

  it("les réglages ne portent ni texte libre ni catégorie en double", () => {
    expect(NotifyPrefsSchema.safeParse(DEFAULT_NOTIFY_PREFS).success).toBe(true);
    const bad = { ...DEFAULT_NOTIFY_PREFS, types: ["decision", "decision"] };
    expect(NotifyPrefsSchema.safeParse(bad).success).toBe(false);
    const freeText = { ...DEFAULT_NOTIFY_PREFS, note: "x" };
    expect(NotifyPrefsSchema.safeParse(freeText).success).toBe(false);
    const zone = { ...DEFAULT_NOTIFY_PREFS, quiet: { ...DEFAULT_NOTIFY_PREFS.quiet, tz: "a b" } };
    expect(NotifyPrefsSchema.safeParse(zone).success).toBe(false);
  });

  it("par défaut rien n'est réglé : pas de silence, rien ne passe", () => {
    expect(DEFAULT_NOTIFY_PREFS.quiet.enabled).toBe(false);
    expect(DEFAULT_NOTIFY_PREFS.quiet.pass).toEqual([]);
  });

  it("les heures de silence suivent le fuseau du créateur et passent minuit", () => {
    const quiet = { ...DEFAULT_NOTIFY_PREFS.quiet, enabled: true, tz: "Europe/Paris" };
    // 23:30 in Paris (UTC+2 in summer) is 21:30 UTC.
    expect(inQuietHours(quiet, new Date("2026-07-01T21:30:00Z"))).toBe(true);
    expect(inQuietHours(quiet, new Date("2026-07-01T04:00:00Z"))).toBe(true); // 06:00 Paris
    expect(inQuietHours(quiet, new Date("2026-07-01T12:00:00Z"))).toBe(false);
    expect(inQuietHours({ ...quiet, enabled: false }, new Date("2026-07-01T21:30:00Z"))).toBe(
      false,
    );
    expect(inQuietHours({ ...quiet, from: 600, to: 600 }, new Date("2026-07-01T09:00:00Z"))).toBe(
      false,
    );
    // An unknown zone falls back to UTC rather than failing.
    expect(minuteOfDay(new Date("2026-07-01T01:30:00Z"), "Nowhere/Land")).toBe(90);
  });

  it("les trames de présence et de réglages sont strictes", () => {
    const presence = { type: "presence_report", surface: "web", active: true };
    expect(RelayClientFrameSchema.safeParse(presence).success).toBe(true);
    expect(RelayClientFrameSchema.safeParse({ ...presence, product: "x" }).success).toBe(false);
    expect(RelayClientFrameSchema.safeParse({ type: "notify_clear", id: ID }).success).toBe(true);
    const set = { type: "notify_prefs_set", prefs: DEFAULT_NOTIFY_PREFS };
    expect(RelayClientFrameSchema.safeParse(set).success).toBe(true);
    expect(RelayServerFrameSchema.safeParse({ type: "notice", ...notice }).success).toBe(true);
    expect(
      RelayServerFrameSchema.safeParse({ type: "notify_prefs", prefs: DEFAULT_NOTIFY_PREFS })
        .success,
    ).toBe(true);
  });
});
