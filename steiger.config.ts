import fsd from "@feature-sliced/steiger-plugin";
import { defineConfig } from "steiger";

const config: ReturnType<typeof defineConfig> = defineConfig([
  ...fsd.configs.recommended,
  {
    rules: {
      "fsd/import-locality": "error",
    },
  },
]);

export default config;
