import type { Metadata } from "next";
import { Syne, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

const syne = Syne({
  subsets: ["latin"],
  variable: "--font-syne",
  weight: ["500", "700", "800"],
  display: "swap",
});

const plusJakartaSans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-jakarta",
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Violini 3D — Neo-Classical Cyber Orchestra",
  description:
    "Experiência sonora 3D imersiva com Violino interativo em WebGL, síntese física em Tone.js e storytelling visual.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR" className={`${syne.variable} ${plusJakartaSans.variable}`}>
      <body className="bg-void text-white antialiased selection:bg-cyber-cyan selection:text-void">
        {children}
      </body>
    </html>
  );
}
