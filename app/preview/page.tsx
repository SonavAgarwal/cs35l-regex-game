"use client";

import HighlightedText from "@/components/HighlightedText";
import { computeScoreFromMasks, safeRangesFromRegex } from "@/lib/regex";
import { useEffect, useMemo, useState } from "react";

type ParsedQuestion = {
    targetString: string;
    answerRegex: string;
    timeSeconds: number | null;
    prompt?: string;
};

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

function parseQuestionFromCsv(text: string) {
    const rows = parseCsv(text);
    if (rows.length === 0) {
        return { question: null, error: "CSV row is empty." };
    }
    const header = rows[0].map(normalizeHeader);
    const hasHeader =
        header.includes("target_string") && header.includes("answer_regex");
    const dataRow = hasHeader ? rows[1] : rows[0];
    if (!dataRow) {
        return { question: null, error: "Missing data row after header." };
    }
    const idxTarget = hasHeader ? header.indexOf("target_string") : 0;
    const idxAnswer = hasHeader ? header.indexOf("answer_regex") : 1;
    const idxTime = hasHeader ? header.indexOf("time") : 2;
    const idxPrompt = hasHeader ? header.indexOf("prompt") : 3;

    const targetString = decodeTargetString(
        dataRow[idxTarget]?.trim() ?? "",
    );
    const rawRegex = dataRow[idxAnswer]?.trim() ?? "";
    const answerRegex = rawRegex.replace(/\\\\/g, "\\");
    const timeValue = dataRow[idxTime]?.trim() ?? "";
    const timeSeconds = timeValue ? Number(timeValue) : null;
    if (!targetString || !answerRegex) {
        return {
            question: null,
            error: 'Row must include "target_string" and "answer_regex".',
        };
    }
    return {
        question: {
            targetString,
            answerRegex,
            timeSeconds: Number.isNaN(timeSeconds) ? null : timeSeconds,
            prompt: idxPrompt !== -1 ? dataRow[idxPrompt]?.trim() : undefined,
        },
        error: null,
    };
}

function buildMasks(
    targetString: string,
    correctRanges: { start: number; end: number }[],
    userRanges: { start: number; end: number }[],
) {
    const length = targetString.length;
    const maskFromRanges = (ranges: { start: number; end: number }[]) => {
        const mask = new Array(length).fill(false);
        for (const range of ranges) {
            for (let i = range.start; i < range.end; i += 1) {
                mask[i] = true;
            }
        }
        return mask;
    };
    const correctMask = maskFromRanges(correctRanges);
    const userMask = maskFromRanges(userRanges);
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
        correctMask,
        userMask,
        overlap: rangesFromMask(overlap),
        extra: rangesFromMask(extra),
    };
}

export default function PreviewPage() {
    const [csvRow, setCsvRow] = useState("");
    const [parseError, setParseError] = useState<string | null>(null);
    const [question, setQuestion] = useState<ParsedQuestion | null>(null);
    const [regexInput, setRegexInput] = useState("");
    const [showAnswer, setShowAnswer] = useState(false);

    useEffect(() => {
        if (!csvRow.trim()) {
            setQuestion(null);
            setParseError(null);
            return;
        }
        const result = parseQuestionFromCsv(csvRow);
        if (result.error) {
            setQuestion(null);
            setParseError(result.error);
            return;
        }
        setQuestion(result.question);
        setParseError(null);
        setRegexInput("");
        setShowAnswer(false);
    }, [csvRow]);

    const correctRanges = useMemo(() => {
        if (!question) {
            return [];
        }
        return safeRangesFromRegex(
            question.targetString,
            question.answerRegex,
            { silent: true },
        );
    }, [question]);

    const userRanges = useMemo(() => {
        if (!question || !regexInput.trim()) {
            return [];
        }
        return safeRangesFromRegex(question.targetString, regexInput, {
            silent: true,
        });
    }, [question, regexInput]);

    const previewMasks = useMemo(() => {
        if (!question) {
            return {
                correctMask: [],
                userMask: [],
                overlap: [],
                extra: [],
            };
        }
        return buildMasks(
            question.targetString,
            correctRanges,
            userRanges,
        );
    }, [question, correctRanges, userRanges]);

    const isMatch = useMemo(() => {
        if (!question || previewMasks.correctMask.length === 0) {
            return false;
        }
        if (!regexInput.trim()) {
            return false;
        }
        for (let i = 0; i < previewMasks.correctMask.length; i += 1) {
            if (previewMasks.correctMask[i] !== previewMasks.userMask[i]) {
                return false;
            }
        }
        return true;
    }, [
        question,
        previewMasks.correctMask,
        previewMasks.userMask,
        regexInput,
    ]);

    const currentScore = useMemo(() => {
        if (!question || !regexInput.trim()) {
            return null;
        }
        return computeScoreFromMasks(
            previewMasks.correctMask,
            previewMasks.userMask,
        );
    }, [question, previewMasks.correctMask, previewMasks.userMask, regexInput]);

    return (
        <main className="min-h-screen p-6">
            <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
                <header className="border-2 border-black bg-white px-6 py-4">
                    <div className="flex flex-wrap items-center justify-between gap-4">
                        <div className="flex flex-col gap-1">
                            <h1 className="text-2xl font-semibold uppercase">
                                Regex Preview
                            </h1>
                            <p className="text-xs uppercase">
                                Paste a CSV row to practice one question.
                            </p>
                        </div>
                    </div>
                </header>

                <section className="border-2 border-black bg-white p-6">
                    <label className="text-base uppercase">CSV Row</label>
                    <textarea
                        value={csvRow}
                        onChange={(event) => setCsvRow(event.target.value)}
                        rows={4}
                        className="mt-3 w-full border-2 border-black bg-transparent px-3 py-2 text-xl"
                        placeholder={`"AAA","A",20,"match all the As"`}
                    />
                    <div className="mt-4 flex flex-wrap items-center gap-3">
                        <span className="text-xs uppercase">
                            Order: target_string, answer_regex, time, prompt
                        </span>
                    </div>
                    {parseError ? (
                        <p className="mt-3 text-xs uppercase">{parseError}</p>
                    ) : null}
                </section>

                {question ? (
                    <section className="border-2 border-black bg-white p-6">
                        <div className="flex flex-wrap items-center justify-between gap-4 text-xl uppercase">
                            <span>Practice Question</span>
                            {question.timeSeconds ? (
                                <span>Time: {question.timeSeconds}s</span>
                            ) : null}
                        </div>
                        <div className="mt-6 flex flex-col gap-6">
                            <p className="text-xl font-semibold uppercase">
                                {question.prompt
                                    ? question.prompt
                                    : "Write a regex that matches the green text."}
                            </p>
                            <HighlightedText
                                text={question.targetString}
                                ranges={correctRanges}
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
                                />
                                {regexInput.trim() ? (
                                    <p className="text-base uppercase">
                                        {isMatch
                                            ? "Match!"
                                            : "Not matching yet."}
                                    </p>
                                ) : null}
                                {currentScore !== null ? (
                                    <p className="text-base uppercase">
                                        Current score: {currentScore}/100
                                    </p>
                                ) : null}
                            </div>
                            <div className="flex flex-col gap-3">
                                <p className="text-base uppercase">Preview:</p>
                                <HighlightedText
                                    text={question.targetString}
                                    ranges={previewMasks.overlap}
                                    highlightClass="bg-[var(--match)] text-black"
                                    secondaryRanges={previewMasks.extra}
                                    secondaryClass="bg-emerald-200 text-black"
                                    className="text-4xl leading-14"
                                />
                            </div>
                            <div className="flex flex-wrap items-center gap-3">
                                <button
                                    type="button"
                                    onClick={() =>
                                        setShowAnswer((prev) => !prev)
                                    }
                                    className="border-2 border-black px-4 py-2 text-sm font-semibold uppercase hover:bg-black hover:text-white"
                                >
                                    {showAnswer ? "Hide answer" : "Show answer"}
                                </button>
                                {showAnswer ? (
                                    <span className="text-sm uppercase">
                                        {question.answerRegex}
                                    </span>
                                ) : null}
                            </div>
                        </div>
                    </section>
                ) : null}
            </div>
        </main>
    );
}
