import { z } from "zod";

export const jarvisParentReportActionSchema = z.object({
  resolvedChildIssueId: z.string().uuid(),
}).strict();
