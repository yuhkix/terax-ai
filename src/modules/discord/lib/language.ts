// Maps file extensions / canonical filenames to a (label, assetKey) pair used
// by Discord Rich Presence:
//   - label    — human-readable language, shown as `large_text` hover tooltip.
//   - assetKey — direct HTTPS image URL for the small overlay icon. Discord's
//                media proxy rewrites it to mp:external/... at runtime, so no
//                upload to the Discord developer portal is required.

type Entry = { label: string; key: string | null };

// Discord's IPC RPC won't render SVG reliably and its server-side media proxy
// can't reach local files. wsrv.nl is a free public image proxy that fetches
// the devicon SVG and re-encodes it as PNG on the fly — single URL, no
// infrastructure, no upload to the Discord developer portal.
const ICON = (slug: string): string =>
  `https://wsrv.nl/?url=cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/${slug}/${slug}-original.svg&output=png&w=256&h=256`;

export const TERMINAL_ICON_URL = ICON("bash");
export const GIT_ICON_URL = ICON("git");

const EXTENSIONS: Record<string, Entry> = {
  ts: { label: "TypeScript", key: ICON("typescript") },
  tsx: { label: "TypeScript React", key: ICON("react") },
  js: { label: "JavaScript", key: ICON("javascript") },
  jsx: { label: "JavaScript React", key: ICON("react") },
  mjs: { label: "JavaScript", key: ICON("javascript") },
  cjs: { label: "JavaScript", key: ICON("javascript") },
  rs: { label: "Rust", key: ICON("rust") },
  go: { label: "Go", key: ICON("go") },
  py: { label: "Python", key: ICON("python") },
  rb: { label: "Ruby", key: ICON("ruby") },
  php: { label: "PHP", key: ICON("php") },
  java: { label: "Java", key: ICON("java") },
  kt: { label: "Kotlin", key: ICON("kotlin") },
  swift: { label: "Swift", key: ICON("swift") },
  c: { label: "C", key: ICON("c") },
  h: { label: "C header", key: ICON("c") },
  cpp: { label: "C++", key: ICON("cplusplus") },
  cc: { label: "C++", key: ICON("cplusplus") },
  cxx: { label: "C++", key: ICON("cplusplus") },
  hpp: { label: "C++ header", key: ICON("cplusplus") },
  cs: { label: "C#", key: ICON("csharp") },
  fs: { label: "F#", key: ICON("fsharp") },
  lua: { label: "Lua", key: ICON("lua") },
  sh: { label: "Shell", key: ICON("bash") },
  bash: { label: "Bash", key: ICON("bash") },
  zsh: { label: "Zsh", key: ICON("bash") },
  fish: { label: "Fish shell", key: ICON("bash") },
  ps1: { label: "PowerShell", key: ICON("powershell") },
  sql: { label: "SQL", key: ICON("mysql") },
  html: { label: "HTML", key: ICON("html5") },
  htm: { label: "HTML", key: ICON("html5") },
  css: { label: "CSS", key: ICON("css3") },
  scss: { label: "Sass", key: ICON("sass") },
  sass: { label: "Sass", key: ICON("sass") },
  less: { label: "Less", key: null },
  json: { label: "JSON", key: null },
  jsonc: { label: "JSON", key: null },
  yaml: { label: "YAML", key: null },
  yml: { label: "YAML", key: null },
  toml: { label: "TOML", key: null },
  xml: { label: "XML", key: null },
  md: { label: "Markdown", key: ICON("markdown") },
  mdx: { label: "Markdown", key: ICON("markdown") },
  markdown: { label: "Markdown", key: ICON("markdown") },
  txt: { label: "Text", key: null },
  vue: { label: "Vue", key: ICON("vuejs") },
  svelte: { label: "Svelte", key: ICON("svelte") },
  astro: { label: "Astro", key: ICON("astro") },
  dart: { label: "Dart", key: ICON("dart") },
  ex: { label: "Elixir", key: ICON("elixir") },
  exs: { label: "Elixir", key: ICON("elixir") },
  erl: { label: "Erlang", key: ICON("erlang") },
  hs: { label: "Haskell", key: ICON("haskell") },
  ml: { label: "OCaml", key: ICON("ocaml") },
  zig: { label: "Zig", key: null },
  nim: { label: "Nim", key: ICON("nim") },
  scala: { label: "Scala", key: ICON("scala") },
  groovy: { label: "Groovy", key: ICON("groovy") },
  r: { label: "R", key: ICON("r") },
  jl: { label: "Julia", key: ICON("julia") },
  proto: { label: "Protocol Buffers", key: null },
  graphql: { label: "GraphQL", key: ICON("graphql") },
  gql: { label: "GraphQL", key: ICON("graphql") },
};

const FILENAMES: Record<string, Entry> = {
  Dockerfile: { label: "Docker", key: ICON("docker") },
  Makefile: { label: "Makefile", key: null },
  CMakeLists: { label: "CMake", key: ICON("cmake") },
  "Cargo.toml": { label: "Rust", key: ICON("rust") },
  "Cargo.lock": { label: "Rust", key: ICON("rust") },
  "go.mod": { label: "Go", key: ICON("go") },
  "go.sum": { label: "Go", key: ICON("go") },
  "package.json": { label: "Node.js", key: ICON("nodejs") },
  "pnpm-lock.yaml": { label: "Node.js", key: ICON("nodejs") },
  "yarn.lock": { label: "Node.js", key: ICON("yarn") },
  "tsconfig.json": { label: "TypeScript", key: ICON("typescript") },
};

function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

export type LanguageInfo = { label: string; assetKey: string | null };

/** Returns label + Discord asset URL for a path, or null if unknown. */
export function languageInfo(path: string): LanguageInfo | null {
  const name = lastSegment(path);
  const exact = FILENAMES[name];
  if (exact) return { label: exact.label, assetKey: exact.key };
  const dot = name.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  const hit = EXTENSIONS[ext];
  return hit ? { label: hit.label, assetKey: hit.key } : null;
}
