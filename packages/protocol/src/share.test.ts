import { describe, expect, it } from "vitest";
import { PHASE_IDS } from "./method-config.js";
import { PRODUCT_STAGES } from "./product-lifecycle.js";
import {
  buildSharePage,
  parseShareFragment,
  parseSharePage,
  SHARE_ID_PATTERN,
  SHARE_KEY_PATTERN,
  SHARE_MAX_STORIES,
  SHARE_PHASES,
  SHARE_STAGES,
  SharePageSchema,
  type ShareSource,
  shareLinkOf,
  shareText,
} from "./share.js";

const ID = "AAAAAAAAAAAAAAAAAAAAAA";
const KEY = "B".repeat(43);

const source = (over: Partial<ShareSource> = {}): ShareSource => ({
  name: "Twosay",
  stage: "development",
  phases: [
    { id: "framing", state: "done" },
    { id: "build", state: "current" },
  ],
  sprint: { goal: "Encaisser plus vite", done: 2, total: 5 },
  delivered: 7,
  stories: [
    { id: "2-1", title: "Page de paiement", state: "done", steps: { done: 3, total: 3 } },
    { id: "2-2", title: "Reçus par courriel", state: "development", steps: null },
  ],
  now: 1_760_000_000_000,
  ...over,
});

describe("the lists the page names", () => {
  it("are the stages of a product and the phases of the method", () => {
    expect([...SHARE_STAGES]).toEqual([...PRODUCT_STAGES]);
    expect([...SHARE_PHASES]).toEqual([...PHASE_IDS]);
  });
});

describe("the link", () => {
  it("puts the identifier and the key in the fragment, and reads them back", () => {
    const link = shareLinkOf("https://share.example.org/", ID, KEY);
    expect(link).toBe(`https://share.example.org/s/#${ID}.${KEY}`);
    expect(link).not.toContain("?");
    expect(parseShareFragment(link.slice(link.indexOf("#")))).toEqual({ id: ID, key: KEY });
  });

  it("refuses a fragment that is not an identifier and a key", () => {
    expect(parseShareFragment("")).toBeUndefined();
    expect(parseShareFragment(`#${ID}`)).toBeUndefined();
    expect(parseShareFragment(`#${ID}.short`)).toBeUndefined();
    expect(parseShareFragment(`#${ID}.${KEY}.more`)).toBeUndefined();
    expect(SHARE_ID_PATTERN.test(ID)).toBe(true);
    expect(SHARE_KEY_PATTERN.test(KEY)).toBe(true);
  });
});

describe("the text of the page", () => {
  it("keeps an ordinary title", () => {
    expect(shareText("Page de paiement", 120)).toBe("Page de paiement");
    expect(shareText("Livraison le 12/10/2026", 120)).toBe("Livraison le 12/10/2026");
    expect(shareText("Achat/vente", 120)).toBe("Achat/vente");
  });

  it("holds back what looks like a secret, a path, a private address or the machine's marker", () => {
    const refused = [
      `token ghp_${"a".repeat(36)}`,
      `clé sk-ant-${"a".repeat(30)}`,
      ["-----BEGIN RSA PRIV", "ATE KEY-----"].join(""),
      "Corriger C:\\Users\\jane\\app\\main.ts",
      "Voir /home/jane/projet",
      "Voir ~/projet",
      "Modifier src/app/page.tsx",
      "Réécrire page.tsx dans src/pages",
      "Relier http://admin:secret@exemple.org",
      "Tester sur 192.168.1.20",
      "Tester sur localhost",
      "redacted:secret",
      "rotation de la clé sk_live_abcdefghijklmnopqrstuv",
      "clé sk-proj-abcdefghijklmnopqrstuvwx",
      "jeton xoxb-1234-5678-abcdef",
      "AIza" + "a".repeat(35),
      "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4",
      "Authorization: Bearer abcdef1234567890abcdef",
      "password=hunter2",
      "Mettre à jour README.md",
      "Copier id_rsa",
      "Voir src/app",
      "Joindre https://staging.acme.io/admin",
      "Pinger 8.8.8.8",
      "Déployer sur mon-serveur.local",
      "Écrire à ada@example.com",
      "Clé ".concat("a".repeat(40)),
      "   ",
    ];
    for (const text of refused) expect(shareText(text, 120), text).toBeUndefined();
  });

  it("removes the invisible tag characters too", () => {
    expect(shareText("a󠁁󠁂b", 40)).toBe("a b");
  });

  it("removes hidden and direction-changing characters and folds spaces", () => {
    expect(shareText("a\u202eb\u200bc  \n d", 40)).toBe("a b c d");
  });

  it("cuts a long text at the limit", () => {
    const cut = shareText("mot ".repeat(200), 20);
    expect(cut).toHaveLength(20);
    expect(cut?.endsWith("…")).toBe(true);
  });
});

describe("the page", () => {
  it("is built from the allow-list only", () => {
    const { page, withheld } = buildSharePage(source());
    expect(withheld).toBe(0);
    expect(Object.keys(page).sort()).toEqual([
      "delivered",
      "made_at",
      "more",
      "phases",
      "product",
      "sprint",
      "stories",
      "v",
    ]);
    expect(page.product).toEqual({ name: "Twosay", stage: "development" });
    expect(page.stories[0]).toEqual({
      id: "2-1",
      title: "Page de paiement",
      state: "done",
      steps: { done: 3, total: 3 },
    });
  });

  it("ignores any other field the caller adds (a cost, a path, an agent, a machine)", () => {
    const rich = {
      ...source(),
      cost: 12.5,
      machine: "Portable de Jane",
      agent: "Jordan",
      path: "C:\\Users\\jane",
      stories: [
        {
          id: "2-1",
          title: "Titre",
          state: "done",
          steps: null,
          agent: "Jordan",
          branch: "story/2-1",
        },
      ],
    } as unknown as ShareSource;
    const text = JSON.stringify(buildSharePage(rich).page);
    for (const leak of ["12.5", "Portable de Jane", "Jordan", "Users", "story/2-1"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("holds back a title that looks like a secret or a path, and counts it", () => {
    const { page, withheld } = buildSharePage(
      source({
        stories: [
          { id: "2-1", title: "Corriger src/app/page.tsx", state: "todo", steps: null },
          { id: "2-2", title: `Clé ghp_${"a".repeat(36)}`, state: "todo", steps: null },
          { id: "2-3", title: "Un titre propre", state: "todo", steps: null },
        ],
        name: "/home/jane/app",
        sprint: { goal: "redacted:secret", done: 0, total: 3 },
      }),
    );
    expect(withheld).toBe(4);
    expect(page.stories.map((story) => story.title)).toEqual([null, null, "Un titre propre"]);
    expect(page.product.name).toBe("—");
    expect(page.sprint?.goal).toBeNull();
  });

  it("lists at most the limit of stories and counts the others", () => {
    const many = Array.from({ length: SHARE_MAX_STORIES + 5 }, (_, index) => ({
      id: `9-${index}`,
      title: "T",
      state: "todo" as const,
      steps: null,
    }));
    const { page } = buildSharePage(source({ stories: many }));
    expect(page.stories).toHaveLength(SHARE_MAX_STORIES);
    expect(page.more).toBe(5);
  });

  it("never says more done than total", () => {
    const { page } = buildSharePage(
      source({ sprint: { goal: null, done: 9, total: 4 }, delivered: -3 }),
    );
    expect(page.sprint).toEqual({ goal: null, done: 4, total: 4 });
    expect(page.delivered).toBe(0);
  });

  it("is read back by its strict schema, and a page with an extra field is refused", () => {
    const { page } = buildSharePage(source());
    expect(parseSharePage(JSON.stringify(page))).toEqual(page);
    expect(parseSharePage(JSON.stringify({ ...page, cost: 3 }))).toBeUndefined();
    expect(parseSharePage("not json")).toBeUndefined();
    expect(
      SharePageSchema.safeParse({ ...page, product: { ...page.product, machine: "x" } }).success,
    ).toBe(false);
  });
});
