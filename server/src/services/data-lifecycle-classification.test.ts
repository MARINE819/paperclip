import { describe, expect, it } from "vitest";
import { DATA_LIFECYCLE_CLASSES } from "@paperclipai/shared";
import { classifyDataLifecycle, listDataLifecycleClassifications } from "./data-lifecycle-classification.js";

describe("F-01 data lifecycle classification (pure mapping, no DB access)", () => {
  it("has an exhaustive entry for every recognized DataLifecycleClass, no more and no fewer", () => {
    const all = listDataLifecycleClassifications();
    expect(all).toHaveLength(DATA_LIFECYCLE_CLASSES.length);
    const mappedClasses = all.map((c) => c.dataClass).sort();
    expect(mappedClasses).toEqual([...DATA_LIFECYCLE_CLASSES].sort());
  });

  it("[no forced mapping] memory_summary is honestly reported as unmapped with zero tables", () => {
    const mapping = classifyDataLifecycle("memory_summary");
    expect(mapping.status).toBe("unmapped");
    expect(mapping.tables).toHaveLength(0);
  });

  it("[file-based, not a table] backup_metadata is reported as file_based, not mapped to a fake DB table", () => {
    const mapping = classifyDataLifecycle("backup_metadata");
    expect(mapping.status).toBe("file_based");
    expect(mapping.tables).toHaveLength(0);
  });

  it("every other class is mapped to at least one real existing table", () => {
    for (const dataClass of DATA_LIFECYCLE_CLASSES) {
      if (dataClass === "memory_summary" || dataClass === "backup_metadata") continue;
      const mapping = classifyDataLifecycle(dataClass);
      expect(mapping.status).toBe("mapped");
      expect(mapping.tables.length).toBeGreaterThan(0);
    }
  });

  it("[verified_knowledge] is the only class mapped to a table with a real archivedColumn", () => {
    const mapping = classifyDataLifecycle("verified_knowledge");
    expect(mapping.tables[0]?.archivedColumn).toBe("archivedAt");
  });
});
