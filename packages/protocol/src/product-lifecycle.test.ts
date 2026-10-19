import { describe, expect, it } from "vitest";
import {
  baseOrderTypes,
  CreateProductParamsSchema,
  creationOfReference,
  creationReference,
  FilesRequestSchema,
  FoldersDataSchema,
  isBrowseStep,
  isFolderName,
  isProductName,
  MachineReportReader,
  MachineReportSchema,
  OpenProductFolderParamsSchema,
  PRESET_STAGE,
  PROFILE_PRESET_IDS,
  ProductCreationSchema,
  ProductLocationSchema,
  SetProductProfileParamsSchema,
  SetProductStateParamsSchema,
} from "./index.js";

const ULID = "01JA2B3C4D5E6F7G8H9JKMNPQR";

const create = {
  name: "Libère",
  start: "idea",
  location: "home",
  preset: "new-product",
  stage: "framing",
} as const;

describe("creating a product", () => {
  it("takes a name, how to start, a place the machine listed, a profile and a stage", () => {
    expect(CreateProductParamsSchema.safeParse(create).success).toBe(true);
    expect(
      CreateProductParamsSchema.safeParse({ ...create, idea: "Une application de relances." })
        .success,
    ).toBe(true);
  });

  it("refuses a name that is blank, padded, on several lines or too long", () => {
    for (const name of ["", " ", " Libère", "Libère ", "Li\nbère", "x".repeat(81)]) {
      expect(CreateProductParamsSchema.safeParse({ ...create, name }).success, name).toBe(false);
    }
    expect(isProductName("x".repeat(80))).toBe(true);
  });

  it("never takes a path: a place is an identifier and a folder is one name", () => {
    for (const location of ["/home/ada", "C:\\Users", "..", "Home", ""]) {
      expect(CreateProductParamsSchema.safeParse({ ...create, location }).success, location).toBe(
        false,
      );
    }
    const existing = { ...create, start: "existing" } as const;
    expect(CreateProductParamsSchema.safeParse(existing).success).toBe(false);
    for (const folder of ["mon-produit", "Mon produit", "été"]) {
      expect(CreateProductParamsSchema.safeParse({ ...existing, folder }).success, folder).toBe(
        true,
      );
    }
    for (const folder of ["..", ".", "a/b", "a\\b", "C:", "a:b", "x.", "x ", "a\u0000b", "a|b"]) {
      expect(isFolderName(folder), folder).toBe(false);
      expect(CreateProductParamsSchema.safeParse({ ...existing, folder }).success, folder).toBe(
        false,
      );
    }
  });

  it("takes a folder only to start from a repository, and an idea only to start from an idea", () => {
    expect(CreateProductParamsSchema.safeParse({ ...create, folder: "x" }).success).toBe(false);
    expect(
      CreateProductParamsSchema.safeParse({ ...create, start: "empty", idea: "x" }).success,
    ).toBe(false);
    expect(CreateProductParamsSchema.safeParse({ ...create, idea: "x".repeat(4001) }).success).toBe(
      false,
    );
  });

  it("is strict: a field it does not know refuses the order", () => {
    expect(CreateProductParamsSchema.safeParse({ ...create, path: "/tmp" }).success).toBe(false);
  });

  it("goes into a place by folder names, never hidden ones, never a path", () => {
    expect(
      CreateProductParamsSchema.safeParse({ ...create, path: ["Projets", "Clients"] }).success,
    ).toBe(true);
    for (const step of [".", "..", ".git", "a/b", "a\\b", "C:", ""]) {
      expect(isBrowseStep(step), step).toBe(false);
      expect(CreateProductParamsSchema.safeParse({ ...create, path: [step] }).success, step).toBe(
        false,
      );
    }
    expect(
      CreateProductParamsSchema.safeParse({ ...create, path: Array(13).fill("a") }).success,
    ).toBe(false);
    expect(
      CreateProductParamsSchema.safeParse({
        ...create,
        start: "existing",
        folder: "x",
        path: ["a"],
      }).success,
    ).toBe(false);
  });

  it("asks the folders of a place with the same steps, and answers with names only", () => {
    const base = { v: 1, id: ULID, product: ULID, op: "folders", location: "home" } as const;
    expect(FilesRequestSchema.safeParse({ ...base, path: ["Projets"] }).success).toBe(true);
    expect(FilesRequestSchema.safeParse({ ...base, path: ["../x"] }).success).toBe(false);
    expect(FilesRequestSchema.safeParse({ ...base, location: "C:\\" }).success).toBe(false);
    expect(
      FoldersDataSchema.safeParse({
        op: "folders",
        location: "home",
        path: [],
        label: "~",
        folders: ["Projets"],
        truncated: false,
      }).success,
    ).toBe(true);
  });

  it("opens a folder with an order that carries nothing", () => {
    expect(OpenProductFolderParamsSchema.safeParse({}).success).toBe(true);
    expect(OpenProductFolderParamsSchema.safeParse({ path: "C:\\" }).success).toBe(false);
    expect(baseOrderTypes().get("order.product.open_folder/v1")?.target).toBe("bridge");
  });

  it("proposes a stage for each starting profile", () => {
    expect(Object.keys(PRESET_STAGE).sort()).toEqual([...PROFILE_PRESET_IDS].sort());
    expect(PRESET_STAGE["new-product"]).toBe("framing");
    expect(PRESET_STAGE.maintenance).toBe("online");
  });

  it("declares its orders: the idea is sealed, the profile goes to the main machine", () => {
    const registry = baseOrderTypes();
    expect(registry.get("order.product.create/v1")?.sealedParams).toEqual(["idea"]);
    expect(registry.get("order.product.create/v1")?.target).toBe("bridge");
    expect(registry.get("order.product.set_state/v1")?.target).toBe("bridge");
    expect(registry.get("order.product.set_profile/v1")?.target).toBe("primary");
  });

  it("names the ticket of a creation in the reference the receipt carries", () => {
    expect(creationOfReference(creationReference(ULID))).toBe(ULID);
    expect(creationOfReference("creation:nope")).toBeUndefined();
    expect(creationOfReference("forge:forge.github:started")).toBeUndefined();
  });
});

describe("the marks of a product", () => {
  it("asks for at least one mark and only the marks it knows", () => {
    expect(SetProductStateParamsSchema.safeParse({}).success).toBe(false);
    expect(SetProductStateParamsSchema.safeParse({ stage: "launch" }).success).toBe(true);
    expect(SetProductStateParamsSchema.safeParse({ paused: true }).success).toBe(true);
    expect(SetProductStateParamsSchema.safeParse({ archived: false, paused: false }).success).toBe(
      true,
    );
    expect(SetProductStateParamsSchema.safeParse({ stage: "paused" }).success).toBe(false);
    expect(SetProductStateParamsSchema.safeParse({ deleted: true }).success).toBe(false);
  });

  it("carries a whole profile, which the engine's own rules still check", () => {
    const profile = {
      preset: "prototype",
      domains: ["product", "ux", "code"],
      phases: ["framing", "build"],
      specialties: ["backend"],
    };
    expect(SetProductProfileParamsSchema.safeParse({ profile }).success).toBe(true);
    expect(
      SetProductProfileParamsSchema.safeParse({ profile: { ...profile, specialties: [] } }).success,
    ).toBe(false);
  });
});

describe("what a machine reports of the life of its products", () => {
  const report = {
    name: "Mac",
    bridge_version: "1.0.0",
    protocol_version: 1,
    products: [
      {
        id: ULID,
        name: "Libère",
        stage: "development",
        paused: true,
        repository: "none",
        profile: {
          preset: "prototype",
          domains: ["product", "ux", "code"],
          phases: ["framing", "build"],
          specialties: ["backend"],
        },
      },
    ],
    agents: 0,
    tools: [],
    locations: [{ id: "home", label: "~/AgentPlugged", folders: ["vieux-depot"] }],
    creations: [{ id: ULID, name: "Libère", state: "failed", code: "engine" }],
  };

  it("holds the marks, the places and the creations", () => {
    expect(MachineReportSchema.safeParse(report).success).toBe(true);
  });

  it("is read by an older device with the fields it does not know dropped", () => {
    const read = MachineReportReader.safeParse({
      ...report,
      products: [{ ...report.products[0], mood: "happy" }],
      locations: [{ ...report.locations[0], free_bytes: 12 }],
    });
    expect(read.success).toBe(true);
    expect(read.data?.products[0]).not.toHaveProperty("mood");
  });

  it("keeps an unsafe folder name out of the list a device offers", () => {
    expect(
      ProductLocationSchema.safeParse({ id: "home", label: "~", folders: ["a/b"] }).success,
    ).toBe(false);
    expect(
      ProductLocationSchema.safeParse({
        id: "home",
        label: "~",
        folders: Array.from({ length: 51 }, (_, i) => `d${i}`),
      }).success,
    ).toBe(false);
  });

  it("bounds the creations a machine reports", () => {
    expect(ProductCreationSchema.safeParse({ id: ULID, name: "x", state: "running" }).success).toBe(
      true,
    );
    expect(
      ProductCreationSchema.safeParse({ id: "nope", name: "x", state: "running" }).success,
    ).toBe(false);
  });
});
