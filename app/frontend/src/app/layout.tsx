import type { Metadata, Viewport } from "next";

// Bundled fonts: installed with the other packages and served by the app, so
// neither the build nor the browser ever fetches a font from the internet.
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/bricolage-grotesque";
import "./globals.css";
import { AppShell } from "@/components/app-shell";
import { AudioProvider } from "@/lib/audio";
import { StoreProvider } from "@/lib/store";

export const metadata: Metadata = {
  title: {
    default: "SongForge | YuE2 Music GEN WebUI",
    template: "%s · SongForge",
  },
  description: "A local music studio for YuE2: write, generate and refine full songs on your own GPU.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#17181f" },
    { media: "(prefers-color-scheme: light)", color: "#f8f7f5" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh antialiased">
        <StoreProvider>
          <AudioProvider>
            <AppShell>{children}</AppShell>
          </AudioProvider>
        </StoreProvider>
      </body>
    </html>
  );
}
