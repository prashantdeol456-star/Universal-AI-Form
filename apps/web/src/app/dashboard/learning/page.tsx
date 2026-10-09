import { IconCheckCircle, IconHistory, IconSpark, IconStore } from "@/components/icons";
import { Card, EmptyState, PageHeader, Stat } from "@/components/ui";
import { timeAgo } from "@/lib/labels";
import { requirePageUser } from "@/server/auth/session";
import { learningOverview } from "@/server/learning/service";
import { ContributionToggle, MappingsTable } from "./LearningClient";

export default async function LearningPage() {
  const user = await requirePageUser();
  const o = await learningOverview(user);

  return (
    <>
      <PageHeader
        title="Learning"
        description="Every ✓ / ✗ in the extension and every form you fill teaches the assistant which website field is which. Your own mappings are used for you immediately; shared patterns need several different people to agree."
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat icon={<IconCheckCircle size={20} />} tone="green" label="Fields it knows for you" value={o.stats.verifiedMappings} hint={`on ${o.stats.websites} website${o.stats.websites === 1 ? "" : "s"}`} />
        <Stat icon={<IconHistory size={20} />} tone="amber" label="Corrections you made" value={o.stats.corrections} />
        <Stat icon={<IconSpark size={20} />} label="Examples contributed" value={o.contributionEnabled ? o.stats.examples : "Off"} hint={o.contributionEnabled ? "structure only, no values" : "Contribution is turned off"} />
        <Stat
          icon={<IconStore size={20} />}
          tone="gray"
          label="Community knowledge"
          value={o.community.websitePatterns + o.community.globalPatterns}
          hint={`${o.community.websitePatterns} website · ${o.community.globalPatterns} general${o.community.lastRunAt ? ` · updated ${timeAgo(o.community.lastRunAt)}` : ""}`}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="What the assistant learned from you">
          {o.mappings.length === 0 ? (
            <EmptyState icon={<IconSpark size={22} />} title="Nothing learned yet">
              In the extension, press <b>✓ Correct</b> or <b>✗ Change</b> on a field, or fill a form — the assistant remembers it for next time.
            </EmptyState>
          ) : (
            <MappingsTable rows={o.mappings} />
          )}
        </Card>
        <div className="space-y-6">
          <Card title="Sharing">
            <ContributionToggle initial={o.contributionEnabled} />
          </Card>
          <Card title="How learning works">
            <ol className="list-decimal space-y-2 pl-4 text-sm text-gray-600">
              <li>You confirm or correct a field, or fill a form after reviewing it.</li>
              <li>That mapping is saved for <b>you</b> and used on your next visit.</li>
              <li>When at least 2 different people agree on a field of a website, it becomes website knowledge; 3+ people on 2+ websites make a general pattern.</li>
              <li>If people later disagree, the shared pattern is switched off automatically.</li>
              <li>If a form changes, old knowledge is double-checked and you are asked to review.</li>
            </ol>
          </Card>
        </div>
      </div>
    </>
  );
}
