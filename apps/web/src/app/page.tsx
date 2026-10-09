import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/session";

export const dynamic = "force-dynamic";

const STEPS = [
  ["Build one profile", "Type it once, upload documents, or tell the assistant. Every value keeps its source and verification status."],
  ["Open any form", "The Chrome extension detects fields and maps them to your profile — rules and history first, AI only when needed."],
  ["Review, then continue", "Nothing is submitted for you. You confirm every value, and each confirmation makes the next form easier."],
];

export default async function Home() {
  if (await getCurrentUser()) redirect("/dashboard");
  return (
    <main className="mx-auto max-w-5xl px-4 py-16 sm:py-24">
      <p className="text-sm font-semibold text-brand-600">Universal AI Form Assistant</p>
      <h1 className="mt-3 max-w-2xl text-4xl font-semibold tracking-tight text-gray-900 sm:text-5xl">
        Fill government, job and admission forms without retyping your life story.
      </h1>
      <p className="mt-5 max-w-2xl text-lg text-gray-600">
        A verified personal profile, a careful AI that says “I don’t know” instead of guessing, and a cyber-café mode where
        customers stay in control of their data.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Link href="/signup" className="rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-brand-700">
          Create free account
        </Link>
        <Link href="/login" className="rounded-lg border border-gray-300 bg-white px-5 py-2.5 text-sm font-medium text-gray-800 hover:bg-gray-50">
          Sign in
        </Link>
      </div>
      <ol className="mt-16 grid gap-4 sm:grid-cols-3">
        {STEPS.map(([title, body], i) => (
          <li key={title} className="rounded-xl border border-gray-200 bg-white p-5">
            <div className="text-xs font-semibold text-brand-600">Step {i + 1}</div>
            <div className="mt-1 font-semibold">{title}</div>
            <p className="mt-2 text-sm text-gray-600">{body}</p>
          </li>
        ))}
      </ol>
    </main>
  );
}
