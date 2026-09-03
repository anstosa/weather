import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";

const root = process.cwd();
const ignoredDirectories = new Set([
  ".git",
  ".omx",
  "coverage",
  "dist",
  "node_modules",
]);
const textExtensions = new Set([
  "",
  ".css",
  ".html",
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".yml",
  ".yaml",
]);
const expectedProjectDependencies = new Map([
  [
    "@weather/api",
    new Set([
      "@weather/database",
      "@weather/domain",
      "@weather/forecast-adjustment",
    ]),
  ],
  ["@weather/web", new Set()],
  [
    "@weather/worker",
    new Set([
      "@weather/database",
      "@weather/domain",
      "@weather/forecast-adjustment",
      "@weather/providers",
    ]),
  ],
  ["@weather/database", new Set(["@weather/domain"])],
  ["@weather/domain", new Set()],
  ["@weather/forecast-adjustment", new Set(["@weather/domain"])],
  ["@weather/providers", new Set(["@weather/domain"])],
]);
const importRules = [
  {
    allowed: new Set(),
    pathPrefix: "packages/domain/src/",
  },
  {
    allowed: new Set(["@weather/domain"]),
    pathPrefix: "packages/database/src/",
  },
  {
    allowed: new Set(["@weather/domain"]),
    pathPrefix: "packages/providers/src/",
  },
  {
    allowed: new Set(["@weather/domain"]),
    pathPrefix: "packages/forecast-adjustment/src/",
  },
  {
    allowed: new Set([
      "@weather/database",
      "@weather/domain",
      "@weather/forecast-adjustment",
      "@weather/providers",
    ]),
    pathPrefix: "apps/worker/src/",
  },
  {
    allowed: new Set([
      "@weather/database",
      "@weather/domain",
      "@weather/forecast-adjustment",
    ]),
    pathPrefix: "apps/api/src/",
  },
  {
    allowed: new Set(),
    pathPrefix: "apps/web/src/",
  },
];
const failures = [];

// collect supported text files
async function collect(path) {
  const metadata = await stat(path);

  // descend directories
  if (metadata.isDirectory()) {
    // skip generated directories
    if (ignoredDirectories.has(basename(path))) {
      return [];
    }

    const files = [];
    const entries = await readdir(path);

    // walk directory entries
    for (const entry of entries) {
      files.push(...(await collect(join(path, entry))));
    }

    return files;
  }

  // include supported text
  if (textExtensions.has(extname(path))) {
    return [path];
  }

  return [];
}

// find the import boundary
function findImportRule(displayPath) {
  // inspect workspace rules
  for (const rule of importRules) {
    // match the source tree
    if (displayPath.startsWith(rule.pathPrefix)) {
      return rule;
    }
  }

  return undefined;
}

// enforce source imports
function checkProjectImports(displayPath, content) {
  const rule = findImportRule(displayPath);

  // skip non-source files
  if (rule === undefined) {
    return;
  }

  const projectImportPattern =
    /(?:from\s+|import\s+|import\s*\(\s*)["'](@weather\/[^"']+)["']/gu;

  // inspect project imports
  for (const match of content.matchAll(projectImportPattern)) {
    const projectImport = match[1];

    // reject undeclared boundaries
    if (projectImport !== undefined && !rule.allowed.has(projectImport)) {
      failures.push(`${displayPath}: forbidden project import ${projectImport}`);
    }
  }
}

// enforce manifest dependencies
async function checkProjectDependencies(displayPath, content) {
  // skip non-workspace manifests
  if (!displayPath.endsWith("/package.json")) {
    return;
  }

  const manifest = JSON.parse(content);
  const expected = expectedProjectDependencies.get(manifest.name);

  // skip unrelated manifests
  if (expected === undefined) {
    return;
  }

  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);

  // reject forbidden dependencies
  for (const dependency of declared) {
    // check project packages only
    if (dependency.startsWith("@weather/") && !expected.has(dependency)) {
      failures.push(`${displayPath}: forbidden project dependency ${dependency}`);
    }
  }

  // require planned dependencies
  for (const dependency of expected) {
    // report missing edges
    if (!declared.has(dependency)) {
      failures.push(`${displayPath}: missing project dependency ${dependency}`);
    }
  }
}

const files = [];

// collect requested paths
for (const inputPath of process.argv.slice(2)) {
  files.push(...(await collect(resolve(root, inputPath))));
}

// lint collected files
for (const file of files) {
  const displayPath = relative(root, file);
  const content = await readFile(file, "utf8");
  const lines = content.split("\n");

  // require final newlines
  if (!content.endsWith("\n")) {
    failures.push(`${displayPath}: missing final newline`);
  }

  // inspect text lines
  for (const [index, line] of lines.entries()) {
    // reject trailing whitespace
    if (/\s+$/u.test(line)) {
      failures.push(`${displayPath}:${index + 1}: trailing whitespace`);
    }

    // reject tabs
    if (line.includes("\t")) {
      failures.push(`${displayPath}:${index + 1}: tab character`);
    }
  }

  checkProjectImports(displayPath, content);
  await checkProjectDependencies(displayPath, content);
}

// report failures
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Linted ${files.length} files.`);
}
