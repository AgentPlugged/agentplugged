import { NotifyIdSchema } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { notificationId } from "./notify-id.js";

const PRODUCT = "01J9ZQ4V8E3M5N7P9R1S3T5V7X";

describe("l'identifiant opaque d'une notification", () => {
  it("est un condensé de 43 caractères que le protocole accepte, le même des deux côtés", () => {
    const id = notificationId(PRODUCT, "C12");
    expect(NotifyIdSchema.safeParse(id).success).toBe(true);
    expect(id).toBe(notificationId(PRODUCT, "C12"));
  });

  it("distingue deux produits qui ont un point du même nom", () => {
    expect(notificationId(PRODUCT, "C1")).not.toBe(
      notificationId("01J9ZQ4V8E3M5N7P9R1S3T5V7Y", "C1"),
    );
  });

  it("ne laisse rien lire du produit ni du point", () => {
    const id = notificationId(PRODUCT, "decision-prod");
    expect(id).not.toContain("decision");
    expect(id).not.toContain(PRODUCT);
  });
});
