import { describe, expect, it } from "vitest";
import { relativizeCheckpointText, relativizeProductPaths } from "./product-paths.js";

const WINDOWS_ROOT = "C:\\Users\\jane\\Desktop\\shop";
const POSIX_ROOT = "/home/jane/shop";

describe("relativizeProductPaths", () => {
  it("writes an absolute path inside the product as a relative one", () => {
    expect(
      relativizeProductPaths(
        "See C:/Users/jane/Desktop/shop/.agentplugged/docs/vision.md now.",
        WINDOWS_ROOT,
      ),
    ).toBe("See .agentplugged/docs/vision.md now.");
  });

  it("reads backslashes and a drive letter in another case", () => {
    expect(
      relativizeProductPaths("c:\\users\\JANE\\desktop\\shop\\src\\app.ts", WINDOWS_ROOT),
    ).toBe("src/app.ts");
  });

  it("rewrites every path of a text and those between quotes or brackets", () => {
    expect(
      relativizeProductPaths('"/home/jane/shop/a.md" and (/home/jane/shop/docs/b.md)', POSIX_ROOT),
    ).toBe('"a.md" and (docs/b.md)');
  });

  it("leaves a path outside the product, a sibling folder and a climbing path alone", () => {
    const text =
      "/home/jane/other/a.md /home/jane/shop2/a.md /home/jane/shop/../secret.txt /x/home/jane/shop/a.md";
    expect(relativizeProductPaths(text, POSIX_ROOT)).toBe(text);
  });

  it("does nothing without a product folder or with a relative one", () => {
    expect(relativizeProductPaths("/home/jane/shop/a.md", undefined)).toBe("/home/jane/shop/a.md");
    expect(relativizeProductPaths("/home/jane/shop/a.md", "shop")).toBe("/home/jane/shop/a.md");
  });
});

describe("the product folder itself", () => {
  it("is written as a dot", () => {
    expect(relativizeProductPaths("Open /home/jane/shop now", POSIX_ROOT)).toBe("Open . now");
    expect(relativizeProductPaths("In C:/Users/jane/Desktop/shop now", WINDOWS_ROOT)).toBe(
      "In . now",
    );
  });
});

describe("relativizeCheckpointText", () => {
  it("rewrites the title, the summary and the card, and nothing else", () => {
    const fields = {
      title: "Read /home/jane/shop/a.md",
      summary: "In /home/jane/shop/docs/b.md",
      card: {
        effect: "Edit /home/jane/shop/c.md",
        risks: ["Breaks /home/jane/shop/d.md"],
        opinions: [{ agent: "reviewer", view: "Saw /home/jane/shop/e.md" }],
        why: { reason: "Per /home/jane/shop/f.md", rejected: "Not /home/jane/shop/g.md" },
      },
      options: [
        {
          id: "a",
          label: "Use /home/jane/shop/x.md",
          consequence: "Edits /home/jane/shop/docs/y.md",
        },
      ],
      documents: [{ path: "a.md", branch: "main", blob_sha: "abc" }],
    };
    const fixed = relativizeCheckpointText(fields, POSIX_ROOT);
    expect(fixed.title).toBe("Read a.md");
    expect(fixed.summary).toBe("In docs/b.md");
    expect(fixed.card?.effect).toBe("Edit c.md");
    expect(fixed.card?.risks).toEqual(["Breaks d.md"]);
    expect(fixed.card?.opinions).toEqual([{ agent: "reviewer", view: "Saw e.md" }]);
    expect(fixed.card?.why).toEqual({ reason: "Per f.md", rejected: "Not g.md" });
    expect(fixed.documents).toEqual(fields.documents);
    expect(fixed.options).toEqual([{ id: "a", label: "Use x.md", consequence: "Edits docs/y.md" }]);
  });
});
