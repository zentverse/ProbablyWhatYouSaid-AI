import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Probably what you said AI",
    template: "%s | Probably what you said AI",
  },
  description:
    "Multi-provider audio transcription workspace powered by Azure Speech, GPT-4o Transcribe, and Google Speech-to-Text.",
  applicationName: "Probably what you said AI",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
