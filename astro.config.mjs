// @ts-check
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // Used for canonical and Open Graph URLs. Change to the production domain.
  site: "https://www.crhopefoundation.org",
  vite: {
    plugins: [tailwindcss()],
  },
});
