/**
 * Renders the (decrypted, owner-only) output of a computer-task step: the move preview of an
 * organise, file lists, summaries, command output and its review. Text is shown as text only.
 */
type Json = Record<string, unknown>;

const parse = (s: string): Json | null => {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
  } catch {
    return null;
  }
};

export function LocalOutput({ stepKey, output, taskType }: { stepKey: string; output: string; taskType: string }) {
  if (taskType === "local_run_command" && stepKey === "run") {
    return <pre className="max-h-96 overflow-auto rounded-md bg-gray-900 p-2 font-mono text-xs whitespace-pre-wrap text-gray-100">{output || "(no output)"}</pre>;
  }
  const o = parse(output);
  if (!o) return <p className="whitespace-pre-wrap text-gray-700">{output}</p>;
  if (Array.isArray(o.moves)) {
    const moves = o.moves as Array<{ from: string; to: string }>;
    return (
      <details open={moves.length <= 30} className="text-xs">
        <summary className="cursor-pointer text-gray-700">Preview: {moves.length} move(s)</summary>
        <table className="mt-1 w-full">
          <tbody>
            {moves.slice(0, 300).map((m) => (
              <tr key={m.from} className="border-t border-gray-100">
                <td className="py-0.5 pr-2 font-mono break-all text-gray-700">{m.from}</td>
                <td className="text-gray-400">→</td>
                <td className="py-0.5 pl-2 font-mono break-all text-gray-900">{m.to}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {moves.length > 300 && <p className="text-gray-500">…and {moves.length - 300} more</p>}
      </details>
    );
  }
  if (typeof o.overview === "string" && Array.isArray(o.files)) {
    return (
      <div className="space-y-1">
        <p className="text-gray-900">{o.overview}</p>
        <ul className="list-disc pl-5 text-gray-700">
          {(o.files as Array<{ name: string; summary: string }>).map((f) => (
            <li key={f.name}>
              <span className="font-mono text-xs">{f.name}</span>: {f.summary}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (Array.isArray(o.files)) {
    const files = o.files as Array<{ name?: string; path?: string; size: number; summary?: string; words?: number; error?: string; modifiedAt?: string }>;
    return (
      <ul className="max-h-80 space-y-1 overflow-auto text-xs">
        {files.map((f) => (
          <li key={f.name ?? f.path}>
            <span className="font-mono text-gray-900">{f.name ?? f.path}</span> <span className="text-gray-400">{Math.round(f.size / 1024)} KB</span>
            {f.summary && <span className="block text-gray-700">{f.summary}</span>}
            {f.error && <span className="block text-amber-700">{f.error}</span>}
          </li>
        ))}
      </ul>
    );
  }
  if (typeof o.verdict === "string") {
    return (
      <div className="space-y-1">
        <p className="text-gray-900">{String(o.summary ?? "")}</p>
        {typeof o.explanation === "string" && <p className="text-gray-700">{o.explanation}</p>}
        {Array.isArray(o.nextSteps) && o.nextSteps.length > 0 && (
          <ul className="list-disc pl-5 text-gray-700">
            {(o.nextSteps as string[]).map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        )}
        {Array.isArray(o.errorLines) && o.errorLines.length > 0 && <pre className="overflow-auto rounded bg-gray-100 p-1 font-mono text-xs whitespace-pre-wrap">{(o.errorLines as string[]).join("\n")}</pre>}
      </div>
    );
  }
  return <pre className="overflow-auto text-xs whitespace-pre-wrap text-gray-700">{JSON.stringify(o, null, 2)}</pre>;
}
