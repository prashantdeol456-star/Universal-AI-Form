import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Universal AI Form Assistant",
  description: "One verified profile. Every online form, filled faster and safer.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans">{children}</body>
    </html>
  );
}
