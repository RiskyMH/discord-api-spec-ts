import { $ } from "bun";
import path from "path";
import { build } from "./custom-build";

const REPO_URL = "https://github.com/discord/discord-api-spec.git";
const UPSTREAM_DIR = path.join(process.cwd(), "discord-api-spec");
const BUILD_DIR = path.join(process.cwd(), "build");
const OPENAPI_PATH = path.join(UPSTREAM_DIR, "specs/openapi.json");
const OPENAPI_PREVIEW_PATH = path.join(UPSTREAM_DIR, "specs/openapi_preview.json");

async function ensureUpstreamRepo() {
  if ((await $`test -d ${UPSTREAM_DIR}`.quiet().nothrow()).exitCode === 0) {
    console.log("Pulling latest from upstream repo...");
    await $`git -C ${UPSTREAM_DIR} pull`.quiet();
  } else {
    console.log("Cloning upstream repo...");
    await $`git clone --depth=1 ${REPO_URL} ${UPSTREAM_DIR}`;
  }
}

async function ensureBuildDirs() {
  if ((await $`test -d ${BUILD_DIR}`.quiet().nothrow()).exitCode !== 0) {
    await $`mkdir ${BUILD_DIR}`;
  }
}

async function buildFiles() {
  await build({
    srcFile: OPENAPI_PATH,
    outFile: path.join(BUILD_DIR, "discord-api-spec.ts"),
    outFileJs: path.join(BUILD_DIR, "discord-api-spec.js"),
    outFileZod: path.join(BUILD_DIR, "discord-api-spec.zod.js"),
  });

  await build({
    srcFile: OPENAPI_PREVIEW_PATH,
    outFile: path.join(BUILD_DIR, "preview/discord-api-spec.ts"),
    outFileJs: path.join(BUILD_DIR, "preview/discord-api-spec.js"),
    outFileZod: path.join(BUILD_DIR, "preview/discord-api-spec.zod.js"),
  });
}

async function updatepackageJsonVersion() {
  const packageJsonPath = path.join(process.cwd(), "package.json");
  const packageJson = await Bun.file(packageJsonPath).json();
  const specVersion = (await Bun.file(OPENAPI_PATH).json()).info.version;
  const commitMsg = await $`git -C ${UPSTREAM_DIR} log -1 --format=%s`.text();
  const match = commitMsg.match(/\((\d+)\)/);
  const specCommit = match ? match[1] : "0";
  packageJson.version = `${specVersion}.0.${specCommit}`;
  await Bun.write(packageJsonPath, JSON.stringify(packageJson, null, 2));
}

async function checkViaTsc() {
  console.log("Checking generated files via tsc...");
  await $`bunx tsc ${Array.from(new Bun.Glob("./build/**/*.{js,ts}").scanSync("."))} --noEmit --allowJs --checkJs --allowSyntheticDefaultImports`.quiet();
  console.log("TypeScript check passed.");
}

async function main() {
  await Bun.$`rm -rf ${BUILD_DIR}`;
  await ensureUpstreamRepo();
  await ensureBuildDirs();
  await buildFiles();
  await updatepackageJsonVersion()
  await checkViaTsc();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

