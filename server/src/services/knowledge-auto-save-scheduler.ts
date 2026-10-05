/**
 * F-07 scheduler wiring. `createMemoryCandidateReconcilerScheduler`'s
 * implementation is already fully generic (setInterval + `.unref()` +
 * startup-once + single-flight + swallow-and-log — see its own module doc)
 * and is not actually specific to memory candidates; per the CEO's explicit
 * instruction not to build a new generic job framework, this module reuses
 * it directly under F-07-appropriate local names rather than duplicating
 * its ~90 lines of already-tested timer/single-flight logic.
 */
export {
  createMemoryCandidateReconcilerScheduler as createKnowledgeAutoSaveScheduler,
  type MemoryCandidateReconcilerSchedulerDeps as KnowledgeAutoSaveSchedulerDeps,
  type MemoryCandidateReconcilerSchedulerLogger as KnowledgeAutoSaveSchedulerLogger,
  type MemoryCandidateReconcilerScheduler as KnowledgeAutoSaveScheduler,
} from "./memory-candidate-reconciler-scheduler.js";
