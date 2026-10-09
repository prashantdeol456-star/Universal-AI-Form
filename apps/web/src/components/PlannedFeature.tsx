import { Card } from "./ui";

/**
 * Shown for navigation entries whose feature is not built yet. Deliberately
 * has no action buttons: the product must never pretend unfinished features work.
 */
export function PlannedFeature({ title, phase, points }: { title: string; phase: number; points: string[] }) {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-gray-900">{title}</h1>
      <Card>
        <p className="text-sm font-medium text-gray-900">Not available yet — planned for phase {phase}.</p>
        <p className="mt-1 text-sm text-gray-500">What this section will do:</p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-gray-600">
          {points.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </Card>
    </>
  );
}
