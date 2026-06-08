import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  {
    ignores: [".next/**", ".open-next/**", "node_modules/**", "coverage/**", "dist/**"]
  },
  ...nextVitals,
  ...nextTypescript
];

export default eslintConfig;
