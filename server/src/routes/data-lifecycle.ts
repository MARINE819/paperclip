import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { dataLifecyclePolicies } from "@paperclipai/db";
import type { DataLifecycleClass } from "@paperclipai/shared";
import { DATA_LIFECYCLE_CLASSES } from "@paperclipai/shared";
import { badRequest } from "../errors.js";
import { assertInstanceAdmin } from "./authz.js";
import { listDataLifecycleClassifications } from "../services/data-lifecycle-classification.js";
import { computeDryRun } from "../services/data-lifecycle-dry-run.js";

// F-01 Data Lifecycle / Data Governance — READ-ONLY routes only. There is
// deliberately no write endpoint in this batch: no POST/PATCH to create or
// edit a data_lifecycle_policies row, no cleanup-execution endpoint. See
// docs/contracts/nexora-f01-data-lifecycle-api.md.

export function dataLifecycleRoutes(db: Db) {
  const router = Router();

  router.get("/data-lifecycle/policies", async (req, res) => {
    assertInstanceAdmin(req);
    const policies = await db.select().from(dataLifecyclePolicies);
    res.json({ policies });
  });

  router.get("/data-lifecycle/summary", async (req, res) => {
    assertInstanceAdmin(req);
    const policies = await db.select().from(dataLifecyclePolicies);
    const policyByClass = new Map(policies.map((p) => [p.dataClass, p]));
    const classifications = listDataLifecycleClassifications().map((classification) => ({
      dataClass: classification.dataClass,
      description: classification.description,
      status: classification.status,
      tables: classification.tables,
      notes: classification.notes,
      policy: policyByClass.get(classification.dataClass) ?? null,
    }));
    res.json({ classifications });
  });

  router.get("/data-lifecycle/dry-run", async (req, res) => {
    assertInstanceAdmin(req);
    const dataClass = typeof req.query.dataClass === "string" ? req.query.dataClass : undefined;
    if (!dataClass || !DATA_LIFECYCLE_CLASSES.includes(dataClass as DataLifecycleClass)) {
      throw badRequest(`dataClass is required and must be one of ${DATA_LIFECYCLE_CLASSES.join(", ")}`);
    }
    const result = await computeDryRun(db, dataClass as DataLifecycleClass);
    res.json({ result });
  });

  return router;
}
