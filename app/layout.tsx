import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  const imageUrl = new URL("/og.png", `${protocol}://${host}`).toString();

  return {
    title: "Clara — sua voz, mais clara",
    description:
      "Comunicação assistida para conduzir consultas médicas com perguntas claras.",
    openGraph: {
      title: "Clara — sua voz, mais clara",
      description: "Faça suas perguntas ao paciente. A Clara escuta, aprende e reproduz sua fala com clareza.",
      images: [{ url: imageUrl, width: 1731, height: 909, alt: "Clara — sua voz, mais clara" }],
      locale: "pt_BR",
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: "Clara — sua voz, mais clara",
      description: "Comunicação assistida para consultas médicas com perfil de voz adaptativo.",
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
      <body>{children}</body>
    </html>
  );
}
