import type { Metadata, Viewport } from "next";

import "./globals.css";
import { AppShell } from "@/components/app-shell";
import { StoreProvider } from "@/lib/store";

export const metadata: Metadata = {
  title: "SongForge",
  description: "Local music studio for YuE2",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#1b1d24",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        <StoreProvider>
          <AppShell>{children}</AppShell>
        </StoreProvider>
      </body>
    </html>
  );
}
