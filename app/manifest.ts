import type { MetadataRoute } from "next";

// Lets Android install the page as a standalone app without browser bars.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "SolveSnap",
    short_name: "SolveSnap",
    description: "Toma una foto de un ejercicio y obtén la solución.",
    start_url: "/",
    display: "standalone",
    background_color: "#f6f7f9",
    theme_color: "#f6f7f9",
  };
}
