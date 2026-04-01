module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "body-max-line-length": [0, "always", Infinity],
    "footer-max-line-length": [0, "always", Infinity],
    "footer-leading-blank": [0, "always"],
    "trailer-exists": [2, "never", "Co-authored-by"],
  },
}
