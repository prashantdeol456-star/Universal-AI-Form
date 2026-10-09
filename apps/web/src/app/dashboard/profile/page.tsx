import { requirePageUser } from "@/server/auth/session";
import { getProfile } from "@/server/profile/service";
import { ProfileEditor } from "./ProfileEditor";

export default async function ProfilePage() {
  const user = await requirePageUser("profile:read_own");
  const profile = await getProfile(user);
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-gray-900">My Profile</h1>
          <p className="mt-1 max-w-3xl text-sm text-gray-500">
            Your master profile. Every value records where it came from and whether you verified it. Verified values are never
            overwritten without your confirmation.
          </p>
        </div>
        <div className="text-right text-sm">
          <div className="font-semibold">{profile.completion.percent}% complete</div>
          <div className="text-xs text-gray-500">
            {profile.completion.coreFilled}/{profile.completion.coreTotal} core fields · {profile.completion.verifiedPercent}% verified
          </div>
        </div>
      </div>
      <ProfileEditor fields={profile.fields} customFields={profile.customFields} />
    </>
  );
}
