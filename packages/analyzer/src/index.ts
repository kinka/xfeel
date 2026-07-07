export { runBatchNormalization, checkDuplicate, quickSimilarity, getNormalizationStats } from "./dedup";
export type { DedupResult, DuplicateCandidate } from "./dedup";

export {
  getEmotionHeatmap, getEmotionTrends, getLifePhases,
  comparePersons, getEntityTimeline, getAnalyticsSummary,
} from "./temporal";
export type { EmotionHeatmap, EmotionTrend, LifePhase, PersonComparison, EntityTimeline } from "./temporal";

export { getOwnerDailyMoods, getOwnerEmotionReview } from "./owner-emotions";
export type { DayMood, EmotionCount, EmotionWeekBucket, OwnerEmotionReview, Valence } from "./owner-emotions";

export { getMilestones, peekMilestones, scheduleMilestoneRebuild } from "./milestone-curation";
export type { MilestoneItem, MilestoneSnapshot } from "./milestone-curation";
