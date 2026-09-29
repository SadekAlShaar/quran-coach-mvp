import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "مدرّب التلاوة",
  description: "تدريب على قراءة القرآن مع تصحيح آلي مساعد",
  manifest: "/manifest.webmanifest",
  themeColor: "#12372a",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ar" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
