import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// The schema is entirely optional.
// You can delete this file (schema.ts) and the
// app will continue to work.
// The schema provides more precise TypeScript types.
export default defineSchema({
  games: defineTable({
    code: v.string(),
    hostUid: v.string(),
    status: v.union(
      v.literal("setup"),
      v.literal("active"),
      v.literal("finished"),
    ),
    currentQuestionIndex: v.number(),
    questionStartedAt: v.number(),
    createdAt: v.number(),
  }).index("by_code", ["code"]),
  questions: defineTable({
    gameId: v.id("games"),
    index: v.number(),
    targetString: v.string(),
    answerRegex: v.string(),
    timeSeconds: v.number(),
    prompt: v.optional(v.string()),
  }).index("by_game", ["gameId", "index"]),
  players: defineTable({
    gameId: v.id("games"),
    uid: v.string(),
    name: v.string(),
    totalScore: v.number(),
    streakCount: v.number(),
    lastFullScoreQuestionIndex: v.number(),
  })
    .index("by_game", ["gameId"])
    .index("by_game_uid", ["gameId", "uid"]),
  submissions: defineTable({
    gameId: v.id("games"),
    playerId: v.id("players"),
    questionIndex: v.number(),
    regex: v.string(),
    score: v.number(),
    fullScore: v.boolean(),
    streakBonus: v.number(),
    createdAt: v.number(),
  }).index("by_game_player_question", [
    "gameId",
    "playerId",
    "questionIndex",
  ]),
});
