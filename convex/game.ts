import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const GAME_CODE_LENGTH = 6;
const FULL_SCORE = 100;
const STREAK_BONUS = 50;

function randomGameCode() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < GAME_CODE_LENGTH; i += 1) {
        code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return code;
}

function parseRegex(raw: string) {
    let pattern = raw.trim();
    let flags = "";
    if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
        const lastSlash = pattern.lastIndexOf("/");
        flags = pattern.slice(lastSlash + 1);
        pattern = pattern.slice(1, lastSlash);
    }
    if (!flags.includes("g")) {
        flags += "g";
    }
    return new RegExp(pattern, flags);
}

function buildMatchMask(text: string, regex: RegExp) {
    const mask = new Array(text.length).fill(false);
    regex.lastIndex = 0;
    while (true) {
        const match = regex.exec(text);
        if (!match) {
            break;
        }
        const value = match[0] ?? "";
        if (value.length === 0) {
            if (regex.lastIndex < text.length) {
                regex.lastIndex += 1;
                continue;
            }
            break;
        }
        const start = match.index;
        const end = Math.min(text.length, start + value.length);
        for (let i = start; i < end; i += 1) {
            mask[i] = true;
        }
    }
    return mask;
}

function maskToRanges(mask: boolean[]) {
    const ranges: { start: number; end: number }[] = [];
    let start = -1;
    for (let i = 0; i <= mask.length; i += 1) {
        if (i < mask.length && mask[i]) {
            if (start === -1) {
                start = i;
            }
            continue;
        }
        if (start !== -1) {
            ranges.push({ start, end: i });
            start = -1;
        }
    }
    return ranges;
}

function computeScore({
    correctMask,
    userMask,
}: {
    correctMask: boolean[];
    userMask: boolean[];
}) {
    const total = correctMask.length;
    if (total === 0) {
        return FULL_SCORE;
    }
    let correctCount = 0;
    let extraCount = 0;
    let targetCount = 0;
    for (let i = 0; i < total; i += 1) {
        const shouldMatch = correctMask[i];
        const didMatch = userMask[i];
        if (shouldMatch) {
            targetCount += 1;
        }
        if (didMatch && shouldMatch) {
            correctCount += 1;
        }
        if (didMatch && !shouldMatch) {
            extraCount += 1;
        }
    }
    if (targetCount === 0) {
        return extraCount === 0 ? FULL_SCORE : 0;
    }
    const raw = Math.max(0, (correctCount - extraCount) / targetCount);
    return Math.round(FULL_SCORE * raw);
}

export const createGame = mutation({
    args: {
        hostUid: v.string(),
    },
    handler: async (ctx, args) => {
        let code = randomGameCode();
        let existing = await ctx.db
            .query("games")
            .withIndex("by_code", (q) => q.eq("code", code))
            .unique();
        while (existing) {
            code = randomGameCode();
            existing = await ctx.db
                .query("games")
                .withIndex("by_code", (q) => q.eq("code", code))
                .unique();
        }
        const gameId = await ctx.db.insert("games", {
            code,
            hostUid: args.hostUid,
            status: "setup",
            currentQuestionIndex: 0,
            questionStartedAt: 0,
            createdAt: Date.now(),
        });
        return { gameId, code };
    },
});

export const resumeHost = mutation({
    args: {
        code: v.string(),
        hostUid: v.string(),
    },
    handler: async (ctx, args) => {
        const game = await ctx.db
            .query("games")
            .withIndex("by_code", (q) => q.eq("code", args.code.toUpperCase()))
            .unique();
        if (!game) {
            throw new Error("Game not found.");
        }
        if (game.hostUid !== args.hostUid) {
            throw new Error("Host verification failed.");
        }
        return { gameId: game._id, code: game.code };
    },
});

export const addQuestions = mutation({
    args: {
        gameId: v.id("games"),
        hostUid: v.string(),
        questions: v.array(
            v.object({
                targetString: v.string(),
                answerRegex: v.string(),
                timeSeconds: v.number(),
                prompt: v.optional(v.string()),
            }),
        ),
    },
    handler: async (ctx, args) => {
        const game = await ctx.db.get(args.gameId);
        if (!game) {
            throw new Error("Game not found.");
        }
        if (game.hostUid !== args.hostUid) {
            throw new Error("Host verification failed.");
        }
        const existing = await ctx.db
            .query("questions")
            .withIndex("by_game", (q) => q.eq("gameId", args.gameId))
            .collect();
        for (const doc of existing) {
            await ctx.db.delete(doc._id);
        }
        for (const [index, question] of args.questions.entries()) {
            await ctx.db.insert("questions", {
                gameId: args.gameId,
                index,
                targetString: question.targetString,
                answerRegex: question.answerRegex,
                timeSeconds: question.timeSeconds,
                prompt: question.prompt,
            });
        }
    },
});

export const startGame = mutation({
    args: { gameId: v.id("games"), hostUid: v.string() },
    handler: async (ctx, args) => {
        const game = await ctx.db.get(args.gameId);
        if (!game) {
            throw new Error("Game not found.");
        }
        if (game.hostUid !== args.hostUid) {
            throw new Error("Host verification failed.");
        }
        const questions = await ctx.db
            .query("questions")
            .withIndex("by_game", (q) => q.eq("gameId", args.gameId))
            .collect();
        if (questions.length === 0) {
            throw new Error("Add questions before starting.");
        }
        await ctx.db.patch(args.gameId, {
            status: "active",
            currentQuestionIndex: 0,
            questionStartedAt: Date.now(),
        });
    },
});

export const advanceQuestion = mutation({
    args: { gameId: v.id("games"), hostUid: v.string() },
    handler: async (ctx, args) => {
        const game = await ctx.db.get(args.gameId);
        if (!game) {
            throw new Error("Game not found.");
        }
        if (game.hostUid !== args.hostUid) {
            throw new Error("Host verification failed.");
        }
        const questions = await ctx.db
            .query("questions")
            .withIndex("by_game", (q) => q.eq("gameId", args.gameId))
            .collect();
        const nextIndex = game.currentQuestionIndex + 1;
        if (nextIndex >= questions.length) {
            await ctx.db.patch(args.gameId, {
                status: "finished",
                currentQuestionIndex: nextIndex,
            });
            return { finished: true };
        }
        await ctx.db.patch(args.gameId, {
            currentQuestionIndex: nextIndex,
            questionStartedAt: Date.now(),
        });
        return { finished: false };
    },
});

export const joinGame = mutation({
    args: {
        code: v.string(),
        name: v.string(),
        uid: v.string(),
    },
    handler: async (ctx, args) => {
        const game = await ctx.db
            .query("games")
            .withIndex("by_code", (q) => q.eq("code", args.code.toUpperCase()))
            .unique();
        if (!game) {
            throw new Error("Game not found.");
        }
        const existing = await ctx.db
            .query("players")
            .withIndex("by_game_uid", (q) =>
                q.eq("gameId", game._id).eq("uid", args.uid),
            )
            .unique();
        if (existing) {
            await ctx.db.patch(existing._id, {
                name: args.name,
            });
            return { gameId: game._id, playerId: existing._id };
        }
        const playerId = await ctx.db.insert("players", {
            gameId: game._id,
            uid: args.uid,
            name: args.name,
            totalScore: 0,
            streakCount: 0,
            lastFullScoreQuestionIndex: -1,
        });
        return { gameId: game._id, playerId };
    },
});

export const extendQuestion = mutation({
    args: {
        gameId: v.id("games"),
        seconds: v.number(),
        hostUid: v.string(),
    },
    handler: async (ctx, args) => {
        const game = await ctx.db.get(args.gameId);
        if (!game || game.status !== "active") {
            throw new Error("Game is not active.");
        }
        if (game.hostUid !== args.hostUid) {
            throw new Error("Host verification failed.");
        }
        const question = await ctx.db
            .query("questions")
            .withIndex("by_game", (q) => q.eq("gameId", args.gameId))
            .filter((q) => q.eq(q.field("index"), game.currentQuestionIndex))
            .unique();
        if (!question) {
            throw new Error("No active question.");
        }
        const now = Date.now();
        const oldEnd = game.questionStartedAt + question.timeSeconds * 1000;
        const nextStartedAt =
            now > oldEnd
                ? now - (question.timeSeconds - args.seconds) * 1000
                : game.questionStartedAt + args.seconds * 1000;
        await ctx.db.patch(args.gameId, {
            questionStartedAt: nextStartedAt,
        });
    },
});

export const endQuestion = mutation({
    args: { gameId: v.id("games"), hostUid: v.string() },
    handler: async (ctx, args) => {
        const game = await ctx.db.get(args.gameId);
        if (!game || game.status !== "active") {
            throw new Error("Game is not active.");
        }
        if (game.hostUid !== args.hostUid) {
            throw new Error("Host verification failed.");
        }
        const question = await ctx.db
            .query("questions")
            .withIndex("by_game", (q) => q.eq("gameId", args.gameId))
            .filter((q) => q.eq(q.field("index"), game.currentQuestionIndex))
            .unique();
        if (!question) {
            return;
        }
        await ctx.db.patch(args.gameId, {
            questionStartedAt: Date.now() - question.timeSeconds * 1000 - 1000,
        });
    },
});

export const endGame = mutation({
    args: { gameId: v.id("games"), hostUid: v.string() },
    handler: async (ctx, args) => {
        const game = await ctx.db.get(args.gameId);
        if (!game) {
            throw new Error("Game not found.");
        }
        if (game.hostUid !== args.hostUid) {
            throw new Error("Host verification failed.");
        }
        await ctx.db.patch(args.gameId, {
            status: "finished",
        });
    },
});

export const kickPlayer = mutation({
    args: {
        gameId: v.id("games"),
        playerId: v.id("players"),
        hostUid: v.string(),
    },
    handler: async (ctx, args) => {
        const game = await ctx.db.get(args.gameId);
        if (!game) {
            throw new Error("Game not found.");
        }
        if (game.hostUid !== args.hostUid) {
            throw new Error("Host verification failed.");
        }
        const player = await ctx.db.get(args.playerId);
        if (!player || player.gameId !== args.gameId) {
            return;
        }
        const submissions = await ctx.db
            .query("submissions")
            .filter((q) => q.eq(q.field("gameId"), args.gameId))
            .filter((q) => q.eq(q.field("playerId"), args.playerId))
            .collect();
        for (const submission of submissions) {
            await ctx.db.delete(submission._id);
        }
        await ctx.db.delete(args.playerId);
    },
});

export const submitRegex = mutation({
    args: {
        gameId: v.id("games"),
        playerId: v.id("players"),
        regex: v.string(),
    },
    handler: async (ctx, args) => {
        const game = await ctx.db.get(args.gameId);
        if (!game || game.status !== "active") {
            return { accepted: false, reason: "Game is not active." };
        }
        const question = await ctx.db
            .query("questions")
            .withIndex("by_game", (q) => q.eq("gameId", args.gameId))
            .filter((q) => q.eq(q.field("index"), game.currentQuestionIndex))
            .unique();
        if (!question) {
            return { accepted: false, reason: "No active question." };
        }
        const now = Date.now();
        if (now - game.questionStartedAt > question.timeSeconds * 1000) {
            return { accepted: false, reason: "Time is up." };
        }
        const existing = await ctx.db
            .query("submissions")
            .withIndex("by_game_player_question", (q) =>
                q
                    .eq("gameId", args.gameId)
                    .eq("playerId", args.playerId)
                    .eq("questionIndex", question.index),
            )
            .unique();
        if (existing) {
            return { accepted: false, reason: "Already submitted." };
        }

        let correctMask: boolean[] = [];
        let userMask: boolean[] = [];
        try {
            const correctRegex = parseRegex(question.answerRegex);
            correctMask = buildMatchMask(question.targetString, correctRegex);
        } catch (error) {
            correctMask = new Array(question.targetString.length).fill(false);
            console.error("Invalid correct regex:", error);
        }
        let regexError = false;
        try {
            const userRegex = parseRegex(args.regex);
            userMask = buildMatchMask(question.targetString, userRegex);
        } catch (error) {
            regexError = true;
            userMask = new Array(question.targetString.length).fill(false);
            console.error("Invalid user regex:", error);
        }
        const score = regexError ? 0 : computeScore({ correctMask, userMask });
        const fullScore = score === FULL_SCORE;

        const player = await ctx.db.get(args.playerId);
        if (!player) {
            return { accepted: false, reason: "Player not found." };
        }
        const streakBonus =
            fullScore &&
            question.index > 0 &&
            player.lastFullScoreQuestionIndex === question.index - 1
                ? STREAK_BONUS
                : 0;
        const nextStreak = fullScore
            ? player.lastFullScoreQuestionIndex === question.index - 1
                ? player.streakCount + 1
                : 1
            : 0;

        await ctx.db.insert("submissions", {
            gameId: args.gameId,
            playerId: args.playerId,
            questionIndex: question.index,
            regex: args.regex,
            score,
            fullScore,
            streakBonus,
            createdAt: now,
        });
        await ctx.db.patch(args.playerId, {
            totalScore: player.totalScore + score + streakBonus,
            streakCount: nextStreak,
            lastFullScoreQuestionIndex: fullScore
                ? question.index
                : player.lastFullScoreQuestionIndex,
        });

        return {
            accepted: true,
            score,
            fullScore,
            streakBonus,
        };
    },
});

export const getGameState = query({
    args: {
        gameId: v.id("games"),
        playerId: v.optional(v.id("players")),
        hostUid: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const game = await ctx.db.get(args.gameId);
        if (!game) {
            return null;
        }
        let playerStatus: "ok" | "kicked" | "unknown" = "unknown";
        if (args.playerId) {
            const player = await ctx.db.get(args.playerId);
            if (!player) {
                playerStatus = "kicked";
            } else if (player.gameId === args.gameId) {
                playerStatus = "ok";
            }
        }
        const questions = await ctx.db
            .query("questions")
            .withIndex("by_game", (q) => q.eq("gameId", args.gameId))
            .collect();
        const question = questions.find(
            (item) => item.index === game.currentQuestionIndex,
        );
        let highlightRanges: { start: number; end: number }[] = [];
        if (question) {
            try {
                const regex = parseRegex(question.answerRegex);
                highlightRanges = maskToRanges(
                    buildMatchMask(question.targetString, regex),
                );
            } catch (error) {
                highlightRanges = [];
                console.error("Invalid regex:", error);
            }
        }
        const players = await ctx.db
            .query("players")
            .withIndex("by_game", (q) => q.eq("gameId", args.gameId))
            .collect();
        const leaderboard = players
            .slice()
            .sort((a, b) => {
                if (b.totalScore !== a.totalScore) {
                    return b.totalScore - a.totalScore;
                }
                return a.name.localeCompare(b.name);
            })
            .map((player, index) => ({
                playerId: player._id,
                name: player.name,
                totalScore: player.totalScore,
                streakCount: player.streakCount,
                rank: index + 1,
            }));
        let aroundPlayer: typeof leaderboard = [];
        let playerRank = null as number | null;
        if (args.playerId) {
            const idx = leaderboard.findIndex(
                (entry) => entry.playerId === args.playerId,
            );
            if (idx !== -1) {
                playerRank = leaderboard[idx].rank;
                aroundPlayer = leaderboard.slice(
                    Math.max(0, idx - 2),
                    Math.min(leaderboard.length, idx + 3),
                );
            }
        }
        const now = Date.now();
        const timeLeftSeconds =
            game.status === "active" && question
                ? Math.max(
                      0,
                      Math.ceil(
                          question.timeSeconds -
                              (now - game.questionStartedAt) / 1000,
                      ),
                  )
                : null;
        const questionOpen =
            game.status === "active" &&
            question &&
            now - game.questionStartedAt <= question.timeSeconds * 1000;
        const isHost = args.hostUid ? game.hostUid === args.hostUid : false;
        return {
            game: {
                id: game._id,
                code: game.code,
                status: game.status,
                currentQuestionIndex: game.currentQuestionIndex,
                questionStartedAt: game.questionStartedAt,
            },
            question: question
                ? {
                      id: question._id,
                      index: question.index,
                      targetString: question.targetString,
                      timeSeconds: question.timeSeconds,
                      prompt:
                          question.prompt ??
                          "Match the green highlights exactly.",
                      highlightRanges,
                      answerRegex: isHost ? question.answerRegex : undefined,
                  }
                : null,
            leaderboard,
            aroundPlayer,
            playerRank,
            playerStatus,
            timeLeftSeconds,
            questionOpen,
            totalQuestions: questions.length,
        };
    },
});
