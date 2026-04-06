import { useState } from "react";
import { Code, ExternalLink, Copy, Check } from "lucide-react";

interface SdkCodeBlockProps {
    code: string;
    docsUrl?: string;
}

/** Lightweight regex-based syntax highlighter for TypeScript snippets. */
function highlightTs(code: string): string {
    // Order matters — later rules can match inside earlier spans,
    // so we tokenize in a single pass with a combined regex.
    return code.replace(
        // 1. single-line comments
        // 2. double-quoted strings
        // 3. single-quoted strings
        // 4. template strings (backtick)
        // 5. numbers (integers, decimals, BigInt)
        // 6. keywords
        // 7. constants (true, false, null, undefined)
        /(\/\/.*$)|("(?:[^"\\]|\\.)*")|('(?:[^'\\]|\\.)*')|(`(?:[^`\\]|\\.)*`)|(\b\d[\d_]*\.?\d*n?\b)|(\b(?:import|from|export|const|let|var|function|return|await|async|new|type|interface)\b)|(\b(?:true|false|null|undefined)\b)/gm,
        (match, comment, dblStr, sglStr, tmplStr, num, keyword, constant) => {
            if (comment) return `<span class="text-zinc-600">${comment}</span>`;
            if (dblStr) return `<span class="text-emerald-400">${dblStr}</span>`;
            if (sglStr) return `<span class="text-emerald-400">${sglStr}</span>`;
            if (tmplStr) return `<span class="text-emerald-400">${tmplStr}</span>`;
            if (num) return `<span class="text-amber-400">${num}</span>`;
            if (keyword) return `<span class="text-blue-400">${keyword}</span>`;
            if (constant) return `<span class="text-amber-300">${constant}</span>`;
            return match;
        },
    );
}

export function SdkCodeBlock({ code, docsUrl }: SdkCodeBlockProps) {
    const [open, setOpen] = useState(false);
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
        await navigator.clipboard.writeText(code);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="mt-2">
            <button
                type="button"
                onClick={() => setOpen(!open)}
                className="inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
            >
                <Code className="h-3 w-3" />
                {open ? "Hide" : "View"} SDK Code
            </button>

            {open && (
                <div className="mt-1.5 rounded-md border border-zinc-800 bg-zinc-900/80 overflow-hidden">
                    <div className="flex items-center justify-between px-3 py-1.5 border-b border-zinc-800">
                        <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider">
                            @mysten/deepbook-v3
                        </span>
                        <div className="flex items-center gap-2">
                            {docsUrl && (
                                <a
                                    href={docsUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-0.5 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
                                >
                                    Docs
                                    <ExternalLink className="h-2.5 w-2.5" />
                                </a>
                            )}
                            <button
                                type="button"
                                onClick={handleCopy}
                                className="inline-flex items-center gap-0.5 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
                            >
                                {copied ? (
                                    <>
                                        <Check className="h-2.5 w-2.5 text-emerald-400" />
                                        <span className="text-emerald-400">Copied</span>
                                    </>
                                ) : (
                                    <>
                                        <Copy className="h-2.5 w-2.5" />
                                        Copy
                                    </>
                                )}
                            </button>
                        </div>
                    </div>
                    <pre className="px-3 py-2.5 text-[11px] leading-relaxed text-zinc-300 overflow-x-auto">
                        <code dangerouslySetInnerHTML={{ __html: highlightTs(code) }} />
                    </pre>
                </div>
            )}
        </div>
    );
}
