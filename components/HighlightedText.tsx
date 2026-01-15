"use client";

import type { MatchRange } from "@/lib/regex";

type HighlightedTextProps = {
    text: string;
    ranges: MatchRange[];
    highlightClass: string;
    secondaryRanges?: MatchRange[];
    secondaryClass?: string;
    className?: string;
};

export default function HighlightedText({
    text,
    ranges,
    highlightClass,
    secondaryRanges = [],
    secondaryClass = "",
    className = "",
}: HighlightedTextProps) {
    const classMap = new Array(text.length).fill("");
    for (const range of ranges) {
        for (let i = range.start; i < range.end; i += 1) {
            classMap[i] = highlightClass;
        }
    }
    for (const range of secondaryRanges) {
        for (let i = range.start; i < range.end; i += 1) {
            if (!classMap[i]) {
                classMap[i] = secondaryClass;
            }
        }
    }
    const pieces: Array<{ text: string; className: string }> = [];
    let cursor = 0;
    while (cursor < text.length) {
        const className = classMap[cursor];
        let end = cursor + 1;
        while (end < text.length && classMap[end] === className) {
            end += 1;
        }
        pieces.push({ text: text.slice(cursor, end), className });
        cursor = end;
    }
    if (pieces.length === 0) {
        pieces.push({ text, className: "" });
    }
    return (
        <pre
            className={`whitespace-pre-wrap wrap-break-word ${
                className || "text-sm leading-6"
            }`}
        >
            {pieces.map((piece, index) =>
                piece.className ? (
                    <span key={index} className={piece.className}>
                        {piece.text}
                    </span>
                ) : (
                    <span key={index}>{piece.text}</span>
                ),
            )}
        </pre>
    );
}
