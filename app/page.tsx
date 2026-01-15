"use client";

import HighlightedText from "@/components/HighlightedText";
import { api } from "@/convex/_generated/api";
import { computeScoreFromMasks, safeRangesFromRegex } from "@/lib/regex";
import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useEffect, useEffectEvent, useMemo, useState } from "react";

const SESSION_KEY = "regex_kahoot_session";
const UID_COOKIE = "regex_uid";

type Session = {
    gameId: string;
    playerId: string;
    code: string;
    name: string;
};

function getCookie(name: string) {
    const parts = document.cookie.split("; ").map((part) => part.trim());
    for (const part of parts) {
        const [key, value] = part.split("=");
        if (key === name) {
            return decodeURIComponent(value ?? "");
        }
    }
    return null;
}

function setCookie(name: string, value: string, days: number) {
    const expires = new Date(Date.now() + days * 86400000).toUTCString();
    document.cookie = `${name}=${encodeURIComponent(
        value,
    )}; expires=${expires}; path=/`;
}

function getOrCreateUid() {
    const existing = getCookie(UID_COOKIE);
    if (existing) {
        return existing;
    }
    const uid = crypto.randomUUID();
    setCookie(UID_COOKIE, uid, 365);
    return uid;
}

function getInitialUid() {
    if (typeof document === "undefined") {
        return null;
    }
    return getOrCreateUid();
}

function getStoredSession() {
    if (typeof window === "undefined") {
        return null;
    }
    const stored = localStorage.getItem(SESSION_KEY);
    if (!stored) {
        return null;
    }
    try {
        return JSON.parse(stored) as Session;
    } catch (error) {
        localStorage.removeItem(SESSION_KEY);
        console.error("Failed to parse session:", error);
        return null;
    }
}

export default function Home() {
    const joinGame = useMutation(api.game.joinGame);
    const submitRegex = useMutation(api.game.submitRegex);
    const initialSession = useMemo(() => getStoredSession(), []);
    const [session, setSession] = useState<Session | null>(initialSession);
    const [uid] = useState<string | null>(() => getInitialUid());
    const [nameInput, setNameInput] = useState(initialSession?.name ?? "");
    const [codeInput, setCodeInput] = useState(initialSession?.code ?? "");
    const [regexInput, setRegexInput] = useState("");
    const [statusMessage, setStatusMessage] = useState<string | null>(null);
    const [timeLeft, setTimeLeft] = useState<number | null>(null);
    const [lastSubmittedQuestion, setLastSubmittedQuestion] = useState<
        string | null
    >(null);
    const [isInputLocked, setIsInputLocked] = useState(false);
    const [kickedMessage, setKickedMessage] = useState<string | null>(null);

    const gameState = useQuery(
        api.game.getGameState,
        session
            ? {
                  gameId: session.gameId as never,
                  playerId: session.playerId as never,
              }
            : "skip",
    );

    useEffect(() => {
        if (!gameState?.question) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setTimeLeft(null);
            return;
        }
        const end =
            gameState.game.questionStartedAt +
            gameState.question.timeSeconds * 1000;
        const tick = () => {
            const remaining = Math.max(0, Math.ceil((end - Date.now()) / 1000));
            setTimeLeft(remaining);
        };
        tick();
        const interval = setInterval(tick, 250);
        return () => clearInterval(interval);
    }, [
        gameState?.game.questionStartedAt,
        gameState?.question?.id,
        gameState?.question?.timeSeconds,
        gameState?.question,
    ]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setRegexInput("");
        setStatusMessage(null);
        setLastSubmittedQuestion(null);
        setIsInputLocked(false);
    }, [gameState?.question?.id]);

    useEffect(() => {
        if (gameState?.playerStatus === "kicked") {
            localStorage.removeItem(SESSION_KEY);
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setSession(null);
            setRegexInput("");
            setStatusMessage(null);
            setIsInputLocked(false);
            setKickedMessage("You were removed by the host.");
        }
    }, [gameState?.playerStatus]);

    const previewRanges = (() => {
        if (!gameState?.question || !regexInput) {
            return [];
        }
        return safeRangesFromRegex(gameState.question.targetString, regexInput);
    })();

    const previewMasks = (() => {
        if (!gameState?.question) {
            return { correct: [], user: [], overlap: [], extra: [] };
        }
        const length = gameState.question.targetString.length;
        const maskFromRanges = (ranges: { start: number; end: number }[]) => {
            const mask = new Array(length).fill(false);
            for (const range of ranges) {
                for (let i = range.start; i < range.end; i += 1) {
                    mask[i] = true;
                }
            }
            return mask;
        };
        const correctMask = maskFromRanges(gameState.question.highlightRanges);
        const userMask = maskFromRanges(previewRanges);
        const overlap: boolean[] = [];
        const extra: boolean[] = [];
        for (let i = 0; i < length; i += 1) {
            overlap[i] = userMask[i] && correctMask[i];
            extra[i] = userMask[i] && !correctMask[i];
        }
        const rangesFromMask = (mask: boolean[]) => {
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
        };
        return {
            correct: correctMask,
            user: userMask,
            overlap: rangesFromMask(overlap),
            extra: rangesFromMask(extra),
        };
    })();

    const currentScore = (() => {
        if (!gameState?.question || !regexInput.trim()) {
            return null;
        }
        return computeScoreFromMasks(previewMasks.correct, previewMasks.user);
    })();

    const submitRegexEvent = useEffectEvent(async () => {
        if (!session || !regexInput.trim()) {
            return;
        }
        try {
            const result = await submitRegex({
                gameId: session.gameId as never,
                playerId: session.playerId as never,
                regex: regexInput.trim(),
            });
            if (!result.accepted) {
                setStatusMessage(result.reason ?? "Submission rejected.");
                return;
            }
            const bonusLine = result.streakBonus
                ? ` +${result.streakBonus} streak`
                : "";
            setStatusMessage(
                `Score ${result.score}${bonusLine} (${result.fullScore ? "full" : "partial"})`,
            );
            if (result.fullScore) {
                setIsInputLocked(true);
            }
        } catch (error) {
            setStatusMessage(
                error instanceof Error ? error.message : "Submission failed.",
            );
        }
    });

    useEffect(() => {
        if (
            !gameState?.question ||
            !gameState.questionOpen ||
            !regexInput.trim()
        ) {
            return;
        }
        const correct = previewMasks.correct;
        const user = previewMasks.user;
        if (correct.length === 0) {
            return;
        }
        let matches = true;
        for (let i = 0; i < correct.length; i += 1) {
            if (correct[i] !== user[i]) {
                matches = false;
                break;
            }
        }
        if (matches && lastSubmittedQuestion !== gameState.question.id) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setLastSubmittedQuestion(gameState.question.id);
            void submitRegexEvent();
        }
    }, [
        gameState?.question,
        gameState?.questionOpen,
        lastSubmittedQuestion,
        previewMasks,
        regexInput,
    ]);

    const handleJoin = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!uid) {
            return;
        }
        setStatusMessage(null);
        try {
            const result = await joinGame({
                code: codeInput.trim().toUpperCase(),
                name: nameInput.trim(),
                uid,
            });
            const nextSession = {
                gameId: result.gameId,
                playerId: result.playerId,
                code: codeInput.trim().toUpperCase(),
                name: nameInput.trim(),
            };
            setSession(nextSession);
            localStorage.setItem(SESSION_KEY, JSON.stringify(nextSession));
        } catch (error) {
            setStatusMessage(
                error instanceof Error
                    ? error.message
                    : "Unable to join the game.",
            );
        }
    };

    const handleLeave = () => {
        localStorage.removeItem(SESSION_KEY);
        setSession(null);
        setRegexInput("");
        setStatusMessage(null);
        setIsInputLocked(false);
    };

    return (
        <main className="min-h-screen p-6">
            <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
                {!session ? (
                    <header className="border-2 border-black bg-white px-6 py-4">
                        <div className="flex flex-wrap items-center justify-between gap-4">
                            <div className="flex flex-col gap-1">
                                <h1 className="text-2xl font-semibold uppercase">
                                    Regex Rave
                                </h1>
                            </div>
                            <div className="flex items-center gap-3 text-xs uppercase">
                                <Link
                                    href="/host"
                                    className="border-2 border-black px-3 py-2 text-xs font-semibold uppercase hover:bg-black hover:text-white"
                                >
                                    Host a game
                                </Link>
                            </div>
                        </div>
                    </header>
                ) : null}

                {!session ? (
                    <section className="border-2 border-black bg-white p-6">
                        <h2 className="text-lg font-semibold uppercase">
                            Join Game
                        </h2>
                        {kickedMessage ? (
                            <p className="mt-3 text-xs uppercase">
                                {kickedMessage}
                            </p>
                        ) : null}
                        <form
                            onSubmit={handleJoin}
                            className="mt-6 flex flex-col gap-4"
                        >
                            <label className="flex flex-col gap-2 text-xs uppercase">
                                Name
                                <input
                                    value={nameInput}
                                    onChange={(event) =>
                                        setNameInput(event.target.value)
                                    }
                                    className="border-2 border-black bg-transparent px-3 py-2 text-sm"
                                    required
                                />
                            </label>
                            <label className="flex flex-col gap-2 text-xs uppercase">
                                Game Code
                                <input
                                    value={codeInput}
                                    onChange={(event) =>
                                        setCodeInput(event.target.value)
                                    }
                                    className="border-2 border-black bg-transparent px-3 py-2 text-sm uppercase"
                                    required
                                />
                            </label>
                            <button
                                type="submit"
                                className="border-2 border-black bg-(--primary) px-4 py-3 text-sm font-semibold uppercase hover:bg-black hover:text-white"
                            >
                                Join
                            </button>
                            {statusMessage ? (
                                <p className="text-xs uppercase">
                                    {statusMessage}
                                </p>
                            ) : null}
                        </form>
                    </section>
                ) : (
                    <section className="border-2 border-black bg-white p-6">
                        <div className="flex flex-wrap items-center justify-between gap-4 text-xl uppercase">
                            <span>
                                {gameState?.game.status === "finished"
                                    ? "Game finished"
                                    : gameState?.game.status === "active"
                                      ? "Live round"
                                      : "Waiting for host"}
                            </span>
                            <button
                                onClick={handleLeave}
                                className="border-2 border-black px-4 py-2 text-xl font-semibold uppercase hover:bg-black hover:text-white"
                            >
                                Leave Game
                            </button>
                        </div>

                        {gameState?.question &&
                        gameState.game.status === "active" ? (
                            <div className="mt-6 flex flex-col gap-6">
                                <div className="flex items-center justify-between text-base uppercase">
                                    <span>
                                        Question: {gameState.question.index + 1}
                                    </span>
                                    <span>
                                        Time:{" "}
                                        {timeLeft !== null
                                            ? `${timeLeft}s`
                                            : "--"}
                                    </span>
                                </div>
                                <p className="text-xl font-semibold uppercase">
                                    {gameState.question.prompt}
                                </p>
                                <HighlightedText
                                    text={gameState.question.targetString}
                                    ranges={gameState.question.highlightRanges}
                                    highlightClass="bg-[var(--match)] text-black"
                                    className="text-4xl leading-14"
                                />
                                <div className="flex flex-col gap-3">
                                    <label className="text-base uppercase">
                                        Your Regex:
                                    </label>
                                    <input
                                        value={regexInput}
                                        onChange={(event) =>
                                            setRegexInput(event.target.value)
                                        }
                                        className="border-2 border-black bg-transparent px-3 py-3 text-4xl"
                                        placeholder="/pattern/g"
                                        disabled={
                                            !gameState.questionOpen ||
                                            isInputLocked
                                        }
                                    />
                                    {statusMessage ? (
                                        <p className="text-base uppercase">
                                            {statusMessage}
                                        </p>
                                    ) : null}
                                </div>
                                <div className="flex flex-col gap-3">
                                    <p className="text-base uppercase">
                                        Preview:
                                    </p>
                                    <HighlightedText
                                        text={gameState.question.targetString}
                                        ranges={previewMasks.overlap}
                                        highlightClass="bg-[var(--match)] text-black"
                                        secondaryRanges={previewMasks.extra}
                                        secondaryClass="bg-emerald-200 text-black"
                                        className="text-4xl leading-14"
                                    />
                                    {currentScore !== null ? (
                                        <p className="text-base uppercase">
                                            Current score: {currentScore}/100
                                        </p>
                                    ) : null}
                                </div>

                                {!gameState.questionOpen ? (
                                    <div className="border-2 border-black bg-background p-4">
                                        {gameState.playerRank ? (
                                            <p className="text-xl font-semibold uppercase">
                                                Your place:{" "}
                                                {gameState.playerRank} of{" "}
                                                {gameState.leaderboard.length}
                                            </p>
                                        ) : (
                                            <p className="text-xl uppercase">
                                                Submit to get your place.
                                            </p>
                                        )}
                                    </div>
                                ) : null}
                            </div>
                        ) : gameState?.game.status === "finished" ? (
                            <div className="mt-6 border-2 border-black bg-background p-4">
                                {gameState.playerRank ? (
                                    <p className="text-xl font-semibold uppercase">
                                        Your final place: {gameState.playerRank}{" "}
                                        of {gameState.leaderboard.length}
                                    </p>
                                ) : (
                                    <p className="text-xl uppercase">
                                        No final rank.
                                    </p>
                                )}
                            </div>
                        ) : (
                            <div className="mt-6 border-2 border-black bg-background p-4 text-xl uppercase">
                                {gameState?.game.status === "setup"
                                    ? "Host is loading questions."
                                    : "Waiting for the next question."}
                            </div>
                        )}
                    </section>
                )}
            </div>
        </main>
    );
}
