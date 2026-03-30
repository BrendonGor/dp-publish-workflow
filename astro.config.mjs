import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  integrations: [
    // Starlight gives us a consistent docs shell while authors only manage Markdown.
    // https://starlight.astro.build/reference/configuration/
    starlight({
      title: "Docs",
      description: "Markdown docs built for digital publishing.",
    }),
  ],
});
