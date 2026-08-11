import { readFileSync, writeFileSync } from "fs";

const targetVersion = process.env.npm_package_version;

// JSON.stringify drops the trailing newline, which turns a one-line version
// bump into a diff that also rewrites the closing brace.
function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`);
}

// read minAppVersion from manifest.json and bump version to target version
let manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeJson("manifest.json", manifest);

// update versions.json with target version and minAppVersion from manifest.json
let versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeJson("versions.json", versions);
