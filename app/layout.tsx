import type { Metadata } from "next";
import { Geist, Inter_Tight } from "next/font/google";
import "./globals.css";

const geist = Geist({ variable: "--font-geist", subsets: ["latin"] });

/** Stand-in for F37 Bolton until the licensed file is dropped in public/fonts. */
const displayFallback = Inter_Tight({
  variable: "--font-display-fallback",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Corgi, your week as a comic",
  description: "Connect the scattered pieces of your digital life. We turn them into one story.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geist.variable} ${displayFallback.variable} h-full`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
