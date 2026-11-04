import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SolveSnap",
  description: "Toma una foto de un ejercicio y obtén la solución.",
  // Lets "Agregar a pantalla de inicio" open the page without browser bars on iOS.
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "SolveSnap",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Draws under the notch; the page adds safe-area padding to compensate.
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f7f9" },
    { media: "(prefers-color-scheme: dark)", color: "#111317" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
