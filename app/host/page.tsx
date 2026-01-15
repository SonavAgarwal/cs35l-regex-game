"use client";

import HighlightedText from "@/components/HighlightedText";
import { api } from "@/convex/_generated/api";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";

const HOST_SESSION_KEY = "regex_kahoot_host_session";
const HOST_UID_COOKIE = "regex_host_uid";

type ParsedQuestion = {
    targetString: string;
    answerRegex: string;
    timeSeconds: number;
    prompt?: string;
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

function getOrCreateHostUid() {
    const existing = getCookie(HOST_UID_COOKIE);
    if (existing) {
        return existing;
    }
    const uid = crypto.randomUUID();
    setCookie(HOST_UID_COOKIE, uid, 365);
    return uid;
}

function getInitialHostUid() {
    if (typeof document === "undefined") {
        return null;
    }
    return getOrCreateHostUid();
}

function parseCsv(text: string) {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (inQuotes) {
            if (char === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i += 1;
                } else {
                    inQuotes = false;
                }
            } else {
                field += char;
            }
            continue;
        }
        if (char === '"') {
            inQuotes = true;
        } else if (char === ",") {
            row.push(field);
            field = "";
        } else if (char === "\n" || char === "\r") {
            if (char === "\r" && text[i + 1] === "\n") {
                i += 1;
            }
            row.push(field);
            field = "";
            if (row.some((value) => value.trim() !== "")) {
                rows.push(row);
            }
            row = [];
        } else {
            field += char;
        }
    }
    if (field.length > 0 || row.length > 0) {
        row.push(field);
        if (row.some((value) => value.trim() !== "")) {
            rows.push(row);
        }
    }
    return rows;
}

function normalizeHeader(value: string) {
    return value.trim().toLowerCase();
}

function decodeTargetString(value: string) {
    return value
        .replace(/\\\\/g, "\\")
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"');
}

export default function RunnerPage() {
    const createGame = useMutation(api.game.createGame);
    const addQuestions = useMutation(api.game.addQuestions);
    const startGame = useMutation(api.game.startGame);
    const advanceQuestion = useMutation(api.game.advanceQuestion);
    const extendQuestion = useMutation(api.game.extendQuestion);
    const endQuestion = useMutation(api.game.endQuestion);
    const endGame = useMutation(api.game.endGame);
    const kickPlayer = useMutation(api.game.kickPlayer);
    const resumeHost = useMutation(api.game.resumeHost);
    const [gameId, setGameId] = useState<string | null>(null);
    const [gameCode, setGameCode] = useState<string | null>(null);
    const [csvError, setCsvError] = useState<string | null>(null);
    const [questions, setQuestions] = useState<ParsedQuestion[]>([]);
    const [uploadStatus, setUploadStatus] = useState<string | null>(null);
    const [timeLeft, setTimeLeft] = useState<number | null>(null);
    const [maxTimeLeft, setMaxTimeLeft] = useState<number | null>(null);
    const [csvText, setCsvText] = useState("");
    const [csvFileName, setCsvFileName] = useState("");
    const [hostUid] = useState<string | null>(() => getInitialHostUid());
    const [showSolution, setShowSolution] = useState(false);

    const gameState = useQuery(
        api.game.getGameState,
        gameId
            ? { gameId: gameId as never, hostUid: hostUid ?? undefined }
            : "skip",
    );

    useEffect(() => {
        if (!hostUid) {
            return;
        }
        const stored = localStorage.getItem(HOST_SESSION_KEY);
        if (!stored) {
            return;
        }
        try {
            const parsed = JSON.parse(stored) as { code: string };
            if (!parsed.code) {
                return;
            }
            void resumeHost({ code: parsed.code, hostUid })
                .then((result) => {
                    setGameId(result.gameId);
                    setGameCode(result.code);
                })
                .catch(() => {
                    localStorage.removeItem(HOST_SESSION_KEY);
                });
        } catch (error) {
            console.error("Failed to parse host session:", error);
            localStorage.removeItem(HOST_SESSION_KEY);
        }
    }, [resumeHost, hostUid]);

    useEffect(() => {
        if (!gameState?.question) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setTimeLeft(null);
            setMaxTimeLeft(null);
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
        setShowSolution(false);
    }, [gameState?.question?.id]);

    useEffect(() => {
        if (timeLeft === null) {
            return;
        }
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setMaxTimeLeft((current) =>
            current === null ? timeLeft : Math.max(current, timeLeft),
        );
    }, [timeLeft]);

    const canStart = gameState?.game.status === "setup" && questions.length > 0;

    const hasTimeExpired = useMemo(() => {
        if (!gameState?.questionOpen && gameState?.game.status === "active") {
            return true;
        }
        if (timeLeft === null) {
            return false;
        }
        return timeLeft <= 0;
    }, [gameState?.game.status, gameState?.questionOpen, timeLeft]);

    const handleCreateGame = async () => {
        if (!hostUid) {
            return;
        }
        const result = await createGame({ hostUid });
        setGameId(result.gameId);
        setGameCode(result.code);
        setCsvError(null);
        setQuestions([]);
        setUploadStatus(null);
        localStorage.setItem(
            HOST_SESSION_KEY,
            JSON.stringify({ code: result.code }),
        );
    };

    const handleClearGame = () => {
        setGameId(null);
        setGameCode(null);
        setQuestions([]);
        setUploadStatus(null);
        setCsvError(null);
        setCsvText("");
        setCsvFileName("");
        localStorage.removeItem(HOST_SESSION_KEY);
    };

    const parseQuestions = (text: string) => {
        const rows = parseCsv(text);
        if (rows.length === 0) {
            return { questions: [], error: "CSV is empty." };
        }
        const header = rows[0].map(normalizeHeader);
        const idxTarget = header.indexOf("target_string");
        const idxAnswer = header.indexOf("answer_regex");
        const idxTime = header.indexOf("time");
        const idxPrompt = header.indexOf("prompt");
        if (idxTarget === -1 || idxAnswer === -1 || idxTime === -1) {
            return {
                questions: [],
                error: 'Missing required columns: "target_string", "answer_regex", "time".',
            };
        }
        const nextQuestions: ParsedQuestion[] = [];
        for (const row of rows.slice(1)) {
            const targetString = decodeTargetString(
                row[idxTarget]?.trim() ?? "",
            );
            const rawRegex = row[idxAnswer]?.trim() ?? "";
            const answerRegex = rawRegex.replace(/\\\\/g, "\\");
            const timeValue = row[idxTime]?.trim() ?? "";
            const timeSeconds = Number(timeValue);
            if (!targetString || !answerRegex || Number.isNaN(timeSeconds)) {
                continue;
            }
            nextQuestions.push({
                targetString,
                answerRegex,
                timeSeconds,
                prompt: idxPrompt !== -1 ? row[idxPrompt]?.trim() : undefined,
            });
        }
        if (nextQuestions.length === 0) {
            return { questions: [], error: "No valid questions found in CSV." };
        }
        return { questions: nextQuestions, error: null };
    };

    const parseAndLoad = async (text: string) => {
        const result = parseQuestions(text);
        if (result.error) {
            setQuestions([]);
            setCsvError(result.error);
            setUploadStatus(null);
            return;
        }
        if (!gameId || !hostUid) {
            setCsvError("Create a game first.");
            setUploadStatus(null);
            return;
        }
        try {
            await addQuestions({
                gameId: gameId as never,
                hostUid,
                questions: result.questions,
            });
            setQuestions(result.questions);
            setCsvError(null);
            setUploadStatus(`Loaded ${result.questions.length} questions.`);
        } catch (error) {
            setUploadStatus(
                error instanceof Error
                    ? error.message
                    : "Failed to load questions.",
            );
        }
    };

    const handleFile = async (file: File) => {
        const text = await file.text();
        setCsvText(text);
    };

    const handleLoadQuestions = async () => {
        await parseAndLoad(csvText);
    };

    const handleStart = async () => {
        if (!gameId || !hostUid) {
            return;
        }
        await startGame({ gameId: gameId as never, hostUid });
    };

    const handleAdvance = async () => {
        if (!gameId || !hostUid) {
            return;
        }
        await advanceQuestion({ gameId: gameId as never, hostUid });
    };

    const handleExtend = async () => {
        if (!gameId || !hostUid) {
            return;
        }
        await extendQuestion({ gameId: gameId as never, seconds: 10, hostUid });
    };

    const handleEndNow = async () => {
        if (!gameId || !hostUid) {
            return;
        }
        await endQuestion({ gameId: gameId as never, hostUid });
    };

    const handleEndGame = async () => {
        if (!gameId || !hostUid) {
            return;
        }
        await endGame({ gameId: gameId as never, hostUid });
    };

    const handleKick = async (playerId: string) => {
        if (!gameId || !hostUid) {
            return;
        }
        await kickPlayer({
            gameId: gameId as never,
            playerId: playerId as never,
            hostUid,
        });
    };

    return (
        <main className="min-h-screen p-6">
            <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
                {gameState?.game.status !== "active" &&
                gameState?.game.status !== "finished" ? (
                    <header className="border-2 border-black bg-white px-6 py-4">
                        <div className="flex flex-col items-center gap-4">
                            <div className="text-4xl font-semibold uppercase">
                                {gameCode
                                    ? `Game Code: ${gameCode}`
                                    : "Create Game"}
                            </div>
                        </div>
                    </header>
                ) : null}

                {!gameId ? (
                    <section className="border-2 border-black bg-white p-6">
                        <button
                            type="button"
                            onClick={handleCreateGame}
                            className="border-2 border-black bg-(--primary) px-4 py-3 text-xl font-semibold uppercase hover:bg-black hover:text-white"
                        >
                            Create Game
                        </button>
                    </section>
                ) : gameState?.game.status !== "active" &&
                  gameState?.game.status !== "finished" ? (
                    <section className="border-2 border-black bg-white p-6">
                        <div className="flex flex-col gap-4">
                            <label className="text-base uppercase">
                                Questions CSV
                            </label>
                            <div className="flex flex-wrap items-center gap-3">
                                <label className="border-2 border-black bg-(--primary) px-4 py-2 text-xl font-semibold uppercase hover:bg-black hover:text-white">
                                    Choose File
                                    <input
                                        type="file"
                                        accept=".csv,text/csv"
                                        onChange={(event) => {
                                            const file =
                                                event.target.files?.[0];
                                            if (file) {
                                                setCsvFileName(file.name);
                                                void handleFile(file);
                                            }
                                        }}
                                        className="hidden"
                                    />
                                </label>
                                <span className="border-2 border-black px-3 py-2 text-base uppercase">
                                    {csvFileName
                                        ? csvFileName
                                        : "No file selected"}
                                </span>
                            </div>
                            <p className="text-base uppercase">Or paste CSV</p>
                            <textarea
                                value={csvText}
                                onChange={(event) =>
                                    setCsvText(event.target.value)
                                }
                                rows={6}
                                className="border-2 border-black bg-transparent px-3 py-2 text-xl"
                                placeholder={`target_string,answer_regex,time,prompt\n"AAA","A",20,"match all the As"`}
                            />
                            <button
                                type="button"
                                onClick={handleLoadQuestions}
                                className="border-2 border-black bg-(--primary) px-4 py-3 text-xl font-semibold uppercase hover:bg-black hover:text-white"
                            >
                                Load Questions
                            </button>
                            {csvError ? (
                                <p className="text-base uppercase">
                                    {csvError}
                                </p>
                            ) : null}
                            {uploadStatus ? (
                                <p className="text-base uppercase">
                                    {uploadStatus}
                                </p>
                            ) : null}
                        </div>
                        {questions.length > 0 ? (
                            <div className="mt-6">
                                <p className="text-base uppercase">
                                    Question Preview
                                </p>
                                <div className="mt-3 flex flex-col text-base uppercase">
                                    {questions.map((question, index) => (
                                        <div
                                            key={`${question.targetString}-${index}`}
                                            className="flex flex-wrap items-center justify-between gap-3 border-b border-black/30 px-3 py-2"
                                        >
                                            <span>Q{index + 1}</span>
                                            <span className="flex-1 whitespace-pre-wrap text-sm leading-4">
                                                {question.targetString}
                                            </span>
                                            <span className="text-sm">
                                                {question.answerRegex}
                                            </span>
                                            <span className="text-sm">
                                                {question.timeSeconds}s
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ) : null}
                        <div className="mt-6 flex flex-wrap items-center gap-3">
                            <button
                                type="button"
                                onClick={handleStart}
                                disabled={!canStart}
                                className="border-2 border-black bg-(--primary) px-4 py-3 text-xl font-semibold uppercase disabled:cursor-not-allowed disabled:opacity-50 hover:bg-black hover:text-white"
                            >
                                Start Game
                            </button>
                            {gameId ? (
                                <button
                                    type="button"
                                    onClick={handleClearGame}
                                    className="border-2 border-black px-4 py-3 text-xl font-semibold uppercase hover:bg-black hover:text-white"
                                >
                                    Clear Game
                                </button>
                            ) : null}
                            <span className="text-base uppercase">
                                Players: {gameState?.leaderboard.length ?? 0}
                            </span>
                        </div>
                        {gameState?.leaderboard.length ? (
                            <div className="mt-6">
                                <p className="text-base uppercase">
                                    Joined Players
                                </p>
                                <div className="mt-3 flex flex-col text-base uppercase">
                                    {gameState.leaderboard.map((entry) => (
                                        <div
                                            key={entry.playerId}
                                            className="flex items-center justify-between gap-3 border-b border-black/30 px-3 py-2"
                                        >
                                            <span>
                                                {entry.rank}. {entry.name}
                                            </span>
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    handleKick(entry.playerId)
                                                }
                                                className="border-2 border-black px-2 py-1 text-sm font-semibold uppercase hover:bg-black hover:text-white"
                                            >
                                                X
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ) : null}
                    </section>
                ) : null}

                {gameState?.game.status === "finished" ? (
                    <section className="border-2 border-black bg-white p-6">
                        <div className="flex flex-wrap items-center justify-between gap-4 text-base uppercase">
                            <span>Game finished</span>
                            <span>Players {gameState.leaderboard.length}</span>
                        </div>
                        <div className="mt-6">
                            <h3 className="text-base font-semibold uppercase">
                                Final Leaderboard
                            </h3>
                            <table className="mt-3 w-full border-2 border-black text-base uppercase">
                                <thead className="border-b-2 border-black bg-white">
                                    <tr>
                                        <th className="px-3 py-2 text-left">
                                            Rank
                                        </th>
                                        <th className="px-3 py-2 text-left">
                                            Name
                                        </th>
                                        <th className="px-3 py-2 text-right">
                                            Score
                                        </th>
                                        <th className="px-3 py-2 text-right">
                                            Streak
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {gameState.leaderboard.length === 0 ? (
                                        <tr>
                                            <td
                                                colSpan={4}
                                                className="px-3 py-3 text-left bg-white"
                                            >
                                                No players yet.
                                            </td>
                                        </tr>
                                    ) : (
                                        gameState.leaderboard.map((entry) => (
                                            <tr
                                                key={entry.playerId}
                                                className="bg-white"
                                            >
                                                <td className="px-3 py-2">
                                                    {entry.rank}
                                                </td>
                                                <td className="px-3 py-2">
                                                    {entry.name}
                                                </td>
                                                <td className="px-3 py-2 text-right">
                                                    {entry.totalScore}
                                                </td>
                                                <td className="px-3 py-2 text-right">
                                                    {entry.streakCount}
                                                </td>
                                            </tr>
                                        ))
                                    )}
                                </tbody>
                            </table>
                        </div>
                        <div className="mt-6">
                            <button
                                type="button"
                                onClick={handleClearGame}
                                className="border-2 border-black px-4 py-3 text-xl font-semibold uppercase hover:bg-black hover:text-white"
                            >
                                Clear Game
                            </button>
                        </div>
                    </section>
                ) : null}

                {gameState?.question && gameState.game.status === "active" ? (
                    <section className="border-2 border-black bg-white p-6">
                        <div className="flex flex-wrap items-center gap-4 text-xl uppercase">
                            <span className="text-xl font-semibold">
                                Question {gameState.question.index + 1} /{" "}
                                {gameState.totalQuestions}
                            </span>
                            <div className="ml-auto flex items-center gap-3">
                                <span className="border-2 border-black px-3 py-2">
                                    Players: {gameState.leaderboard.length}
                                </span>
                                <span className="border-2 border-black px-3 py-2">
                                    Game Code: {gameCode ?? "--"}
                                </span>
                            </div>
                        </div>
                        <div className="mt-4">
                            <div className="flex items-center justify-between text-sm font-semibold uppercase text-black">
                                <span>Time left</span>
                                <span>
                                    {timeLeft !== null ? `${timeLeft}s` : "--"}
                                </span>
                            </div>
                            <div className="mt-2 border-2 border-black bg-white">
                                <div
                                    className="h-6 bg-(--primary) transition-all"
                                    style={{
                                        width: `${
                                            maxTimeLeft
                                                ? Math.max(
                                                      0,
                                                      Math.min(
                                                          1,
                                                          (timeLeft ?? 0) /
                                                              maxTimeLeft,
                                                      ),
                                                  ) * 100
                                                : 0
                                        }%`,
                                    }}
                                />
                            </div>
                        </div>
                        <p className="mt-5 text-xl font-semibold uppercase">
                            {gameState.question.prompt}
                        </p>
                        {showSolution && gameState.question.answerRegex ? (
                            <p className="mt-2 text-xl font-semibold uppercase">
                                Solution: {gameState.question.answerRegex}
                            </p>
                        ) : null}
                        <div className="mt-4 border-2 border-black bg-white p-6">
                            <HighlightedText
                                text={gameState.question.targetString}
                                ranges={gameState.question.highlightRanges}
                                highlightClass="bg-[var(--match)] text-black"
                                className="text-xl leading-12"
                            />
                        </div>

                        {hasTimeExpired ? (
                            <div className="mt-6 flex flex-col gap-4">
                                <div className="mt-2">
                                    <h3 className="text-xl font-semibold uppercase">
                                        Leaderboard
                                    </h3>
                                    <table className="mt-3 w-full border-2 border-black text-xl uppercase">
                                        <thead className="border-b-2 border-black bg-white">
                                            <tr>
                                                <th className="px-3 py-2 text-left">
                                                    Rank
                                                </th>
                                                <th className="px-3 py-2 text-left">
                                                    Name
                                                </th>
                                                <th className="px-3 py-2 text-right">
                                                    Score
                                                </th>
                                                <th className="px-3 py-2 text-right">
                                                    Streak
                                                </th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {gameState.leaderboard.length ===
                                            0 ? (
                                                <tr>
                                                    <td
                                                        colSpan={4}
                                                        className="px-3 py-3 text-left bg-white"
                                                    >
                                                        No players yet.
                                                    </td>
                                                </tr>
                                            ) : (
                                                gameState.leaderboard.map(
                                                    (entry) => (
                                                        <tr
                                                            key={entry.playerId}
                                                            className="bg-white"
                                                        >
                                                            <td className="px-3 py-2">
                                                                {entry.rank}
                                                            </td>
                                                            <td className="px-3 py-2">
                                                                {entry.name}
                                                            </td>
                                                            <td className="px-3 py-2 text-right">
                                                                {
                                                                    entry.totalScore
                                                                }
                                                            </td>
                                                            <td className="px-3 py-2 text-right">
                                                                {
                                                                    entry.streakCount
                                                                }
                                                            </td>
                                                        </tr>
                                                    ),
                                                )
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                                <button
                                    type="button"
                                    onClick={handleAdvance}
                                    className="border-2 border-black bg-(--primary) px-4 py-3 text-xl font-semibold uppercase hover:bg-black hover:text-white"
                                >
                                    {gameState.game.currentQuestionIndex + 1 >=
                                    gameState.totalQuestions
                                        ? "Finish Game"
                                        : "Next Question"}
                                </button>
                            </div>
                        ) : null}

                        <div className="mt-8 flex flex-wrap items-center gap-3">
                            {gameState.question.answerRegex ? (
                                <button
                                    type="button"
                                    onClick={() =>
                                        setShowSolution((value) => !value)
                                    }
                                    className="border-2 border-black px-4 py-3 text-xl font-semibold uppercase hover:bg-black hover:text-white"
                                >
                                    {showSolution
                                        ? "Hide Solution"
                                        : "Show Solution"}
                                </button>
                            ) : null}
                            <button
                                type="button"
                                onClick={handleExtend}
                                className="border-2 border-black px-4 py-3 text-xl font-semibold uppercase hover:bg-black hover:text-white"
                            >
                                +10s
                            </button>
                            {!hasTimeExpired ? (
                                <button
                                    type="button"
                                    onClick={handleEndNow}
                                    className="border-2 border-black px-4 py-3 text-xl font-semibold uppercase hover:bg-black hover:text-white"
                                >
                                    End Now
                                </button>
                            ) : null}
                            <button
                                type="button"
                                onClick={handleEndGame}
                                className="ml-auto border-2 border-black px-4 py-3 text-xl font-semibold uppercase hover:bg-black hover:text-white"
                            >
                                End Game
                            </button>
                        </div>
                    </section>
                ) : null}
            </div>
        </main>
    );
}
