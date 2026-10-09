import { PageHeader } from "@/components/ui";
import { requirePageUser } from "@/server/auth/session";
import { AdminTabs } from "./AdminClient";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requirePageUser("admin:users_view");
  return (
    <>
      <PageHeader
        eyebrow="Super admin"
        title="Administration"
        description="Platform health, accounts, cafés and the learning / model pipeline. Admins see counts and structure — never anyone's profile values, documents, filled forms or chats."
      />
      <AdminTabs />
      {children}
    </>
  );
}
