// A driver as a customer sees them: their name and photo, and their track
// record -- driving only, never a store they also run.
import { averageRating, getRatingSummary, getReputationSummary } from "../../holochain/zomes/reputation";
import { getProfileForAgent } from "../../holochain/zomes/profiles";
import { decodeEntry } from "../../holochain/decode";
import type { Profile } from "../../holochain/types";

export interface DriverStats {
  completedCount: number;
  /// Deliveries they left before picking them up.
  droppedCount: number;
  /// Offers they let lapse, or turned down, without committing.
  lapsedCount: number;
  /// Deliveries a store found them at fault for, having refunded its
  /// customer (docs/REPUTATION.md, phase 3) -- shown, never weighed.
  faultedCount: number;
  avgRating: number;
  reviewCount: number;
  /// Null for one who hasn't set one: shown by their short id instead.
  displayName: string | null;
  /// Their profile photo, if they've added one.
  avatar: string | null;
}

export async function fetchDriverStats(agent: Uint8Array): Promise<DriverStats> {
  const [summary, rating, profileRecord] = await Promise.all([getReputationSummary({ Driver: agent }), getRatingSummary({ Driver: agent }), getProfileForAgent(agent)]);
  const profile = profileRecord ? decodeEntry<Profile>(profileRecord) : null;
  return {
    completedCount: summary.completed_count,
    droppedCount: summary.dropped_count,
    lapsedCount: summary.lapsed_count,
    faultedCount: summary.faulted_count,
    avgRating: averageRating(rating) ?? 0,
    reviewCount: rating.count,
    displayName: profile?.display_name || null,
    avatar: profile?.avatar_data_uri || null,
  };
}
