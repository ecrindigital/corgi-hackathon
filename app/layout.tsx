import type { Metadata } from "next";
import { Archivo } from "next/font/google";
import "./globals.css";

/** Stand-in for ABC Favorit until the licensed files land in public/fonts. */
const fallback = Archivo({
  variable: "--font-fallback",
  subsets: ["latin"],
  weight: ["400", "500", "700", "900"],
});

export const metadata: Metadata = {
  title: "Toonback — Your life, drawn.",
  description: "Turn the scattered pieces of your digital life into a comic that is unmistakably yours.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${fallback.variable} h-full`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
