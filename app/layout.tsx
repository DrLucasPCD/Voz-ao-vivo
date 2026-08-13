import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "clara-voz-assistida.lvsa.chatgpt.site";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  const imageUrl = new URL("/og.png", `${protocol}://${host}`).toString();

  return {
    title: "Clara — sua voz, mais clara",
    description:
      "Comunicação assistida que aprende com a sua voz e reproduz suas frases com clareza.",
    openGraph: {
      title: "Clara — sua voz, mais clara",
      description: "Fale do seu jeito. A Clara escuta, aprende e reproduz sua mensagem com clareza.",
      images: [{ url: imageUrl, width: 1731, height: 909, alt: "Clara — sua voz, mais clara" }],
      locale: "pt_BR",
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: "Clara — sua voz, mais clara",
      description: "Comunicação assistida com perfil de voz adaptativo.",
      images: [imageUrl],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
