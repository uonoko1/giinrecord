import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [reactRouter()],
  /** SITE_ORIGIN (#57) is inlined as import.meta.env.SITE_ORIGIN at build time; unset → relative URLs */
  envPrefix: ["VITE_", "SITE_ORIGIN"],
});
